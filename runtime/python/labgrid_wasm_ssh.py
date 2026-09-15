"""Make labgrid's stock SSHDriver work in the browser, unmodified.

Same principle as labgrid_wasm.py: labgrid is an untouched wheel. SSHDriver
drives the ``ssh``/``scp`` command-line tools through :mod:`subprocess`; there
are no such binaries in Pyodide, and no TCP path into the guest. So this module
installs a subprocess *look-alike* as ``labgrid.driver.sshdriver.subprocess``
(only SSHDriver's module sees it -- the process-wide Popen guard in worker.js
stays for everyone else) that **interprets the exact ssh/scp argv SSHDriver
builds** and executes it over asyncssh, which rides a virtio-serial channel to a
dropbear in the guest (see runtime/js/sshchannel.js and the guest's
lgssh-gateway). Every line of sshdriver.py then runs exactly as upstream wrote
it, so the API, the log messages ("Connected to ...", "Sending command: [...]",
"Socket already closed"), the ExecutionError texts, the retry cadence and the
@step traces are all the stock ones -- which is the whole point.

asyncssh, not paramiko: this Pyodide build has no pthreads, and
``paramiko.Transport`` is a ``threading.Thread`` whose ``start()`` raises
``RuntimeError("can't start new thread")`` before a single byte of key exchange.
asyncssh is pure-async and needs no threads; it runs on a synchronous event loop
this module owns (:class:`SyncLoop`), whose selector blocks on the SharedArrayBuffer
ring exactly the way QEMUDriver._read does, so labgrid's synchronous
``SSHDriver.run()`` drives it through ``run_until_complete()``.

ControlPath is the connection key. ``on_activate`` opens one asyncssh connection
(the "master") over the single serial line; every ``run()``/``scp()``/keepalive
after it is a new channel/session multiplexed on that one connection -- which is
precisely OpenSSH's ControlMaster model. ``-O exit`` closes it. Because a single
serial line carries a single transport, there is one connection at a time. Not
offered: port forwarding (it needs a listening socket the browser cannot
provide) and what spawns a real process next to ssh -- ``interact()``'s
terminal, ``rsync()``, ``sshfs()``; each fails the way its native counterpart
would on a host without that tool.
"""

import asyncio
import os
import re
import shlex
import subprocess as _subprocess
from asyncio import events

import asyncssh


# --- the synchronous event loop --------------------------------------------

# asyncssh is asyncio code, but nothing on labgrid's SSH path is browser-async:
# SSHDriver.run() is a plain blocking call. So asyncssh runs on this loop, which
# never yields to the browser -- its "selector" blocks on the SAB ring (via the
# bridge) the same way the console reader does -- and run_until_complete() works
# straight from synchronous code, even though Pyodide's WebLoop is the ambient
# running loop.

class ChannelTransport(asyncio.Transport):
    """An asyncio.Transport over the single serial channel. Writes go straight
    to the bridge (host -> guest); reads are pumped in by the loop's selector."""

    def __init__(self, loop, extra):
        super().__init__(extra)
        self._loop = loop
        self._protocol = None
        self._closing = False
        self._paused = False

    def set_protocol(self, protocol):
        self._protocol = protocol

    def get_protocol(self):
        return self._protocol

    def is_closing(self):
        return self._closing

    def write(self, data):
        if not self._closing and data:
            self._loop._bridge.writeSsh(_to_js_bytes(data))

    def writelines(self, lines):
        for data in lines:
            self.write(data)

    def can_write_eof(self):
        return False

    def get_write_buffer_size(self):
        return 0

    def set_write_buffer_limits(self, high=None, low=None):
        pass

    def pause_reading(self):
        self._paused = True

    def resume_reading(self):
        self._paused = False

    def is_reading(self):
        return not self._paused

    def close(self):
        if self._closing:
            return
        self._closing = True
        self._loop.call_soon(self._protocol.connection_lost, None)

    def abort(self):
        self.close()

    def _pump(self, timeout_ms):
        """Read one chunk from the channel and hand it to the protocol. Returns
        True if it delivered data (so the loop should run callbacks now)."""
        if self._closing or self._paused:
            return False
        chunk = self._loop._bridge.readSsh(int(timeout_ms), 65536)
        if chunk is None:  # timeout
            return False
        if hasattr(chunk, "to_py"):        # a JS Uint8Array from the worker bridge
            data = bytes(chunk.to_py())
        elif isinstance(chunk, (bytes, bytearray, memoryview)):  # a native test bridge
            data = bytes(chunk)
        else:                              # JsNull or anything unexpected
            return False
        if not data:
            return False
        self._protocol.data_received(data)
        return True


class _Selector:
    """Stands in for a real selectors.BaseSelector. ``select`` is where
    BaseEventLoop._run_once blocks; here it blocks on the ring instead of on fds."""

    def __init__(self, loop):
        self._loop = loop

    def select(self, timeout):
        loop = self._loop
        # Convert the loop's requested wait (seconds, or None for "forever")
        # into a bounded ring read. There is only ever one transport.
        if timeout is not None and timeout <= 0:
            ms = 0
        elif timeout is None:
            ms = 50  # a timer we cannot see must not wedge us; poll in slices
        else:
            ms = min(timeout, 1.0) * 1000
        # _pump returns fast when there is no transport yet, or when asyncssh
        # has paused reading for flow control: in those states BaseEventLoop has
        # a callback ready (the connect step, or the scheduled resume_reading),
        # and _run_once runs it the moment select returns. So select must return
        # promptly here rather than sleeping the slice out -- an earlier version
        # slept while paused and stalled every transfer, because the resume was
        # deferred by up to a second per pause cycle. When a real read is wanted
        # (transport present, not paused) _pump blocks on the ring for up to ms.
        tr = loop._transport
        if tr is not None:
            tr._pump(ms)
        return []  # no fd events: data went straight to the protocol

    def close(self):
        pass


class SyncLoop(asyncio.BaseEventLoop):
    """A real asyncio loop driven synchronously off the SAB ring."""

    def __init__(self, bridge):
        super().__init__()
        self._bridge = bridge
        self._selector = _Selector(self)
        self._transport = None

    def _process_events(self, event_list):
        pass

    def _write_to_self(self):
        pass

    def run_in_executor(self, executor, func, *args):
        # No threads here. asyncssh's local-file reads/writes (scp source/sink)
        # come through this; run them inline and return a finished future.
        fut = self.create_future()
        try:
            fut.set_result(func(*args))
        except BaseException as exc:  # noqa: BLE001  (mirror executor semantics)
            fut.set_exception(exc)
        return fut

    def run_until_complete(self, future):
        # We are called from synchronous code that is itself running inside a
        # task of Pyodide's WebLoop. Two things must be parked for the nested
        # run: the running-loop marker, and -- since CPython 3.14 tracks the
        # current task in the thread state, not per-loop -- the outer task, or
        # every step in here fails with "Cannot enter into task".
        prev_loop = events._get_running_loop()
        prev_task = None
        if prev_loop is not None:
            prev_task = asyncio.tasks._swap_current_task(prev_loop, None)
        events._set_running_loop(None)
        try:
            return super().run_until_complete(future)
        finally:
            events._set_running_loop(prev_loop)
            if prev_task is not None:
                asyncio.tasks._swap_current_task(prev_loop, prev_task)

    async def _create_ssh_connection(self, protocol_factory, **kwargs):
        """The one connection asyncssh opens, wired to the serial channel
        instead of a socket. asyncssh calls loop.create_connection(); we route
        it here from create_connection() below, ignoring host/port."""
        protocol = protocol_factory()
        transport = ChannelTransport(self, {"peername": ("guest", 22),
                                             "sockname": ("local", 0)})
        transport.set_protocol(protocol)
        # asyncio's contract: connection_made() before any data_received(). It
        # is load-bearing here: the guest's dropbear sends its banner and its
        # KEXINIT the moment socat connects it, so that data is usually already
        # sitting in the ring when this connection object is created. If the
        # transport were exposed to the selector first (as a call_soon'd
        # connection_made would allow), the loop's next select() would deliver
        # the banner before connection_made ran; asyncssh would answer it by
        # sending its KEXINIT *before its own version string*, and dropbear --
        # reading a binary packet where an ident line must come first -- would
        # reply UNIMPLEMENTED, which strict KEX turns into an instant
        # disconnect. So: connection_made synchronously (it just sends the
        # client version), and only then let the selector pump this transport.
        protocol.connection_made(transport)
        self._transport = transport
        return transport, protocol

    async def create_connection(self, protocol_factory, host=None, port=None,
                                **kwargs):
        return await self._create_ssh_connection(protocol_factory)


# --- module state -----------------------------------------------------------

_bridge = None          # the worker.js object (readSsh/writeSsh); set by ensure_installed
_loop = None            # the single SyncLoop
_conns = {}             # ControlPath -> asyncssh connection ("the masters")
_installed = False


def _to_js_bytes(data):
    """bytes -> a JS value writeSsh accepts (a list of byte values, like
    writeConsole/writeQmp take)."""
    return list(data)


def _run_sync(coro):
    return _loop.run_until_complete(coro)


# --- argv helpers -----------------------------------------------------------

def _val(args, flag):
    """Value following a `flag` token (e.g. -i, -l, -p, -S, -O), or None."""
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return args[i + 1]
    return None


def _oval(args, key):
    """Value of a `-o key=value` pair, or None."""
    for i, a in enumerate(args):
        if a == "-o" and i + 1 < len(args) and args[i + 1].startswith(key + "="):
            return args[i + 1][len(key) + 1:]
    return None


def _password_from_env(env):
    """SSHDriver passes a password by writing an SSH_ASKPASS script that echoes
    it. Recover it so key-less password auth works too (the demo uses a key)."""
    if not env:
        return None
    path = env.get("SSH_ASKPASS")
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("echo "):
                    return " ".join(shlex.split(line)[1:])
    except OSError:
        return None
    return None


# --- the SSH operations, over asyncssh --------------------------------------

async def _connect(args, env):
    keyfile = _val(args, "-i")
    username = _val(args, "-l")
    password = _password_from_env(env)
    ct = _oval(args, "ConnectTimeout")
    opts = dict(
        username=username,
        known_hosts=None,          # UserKnownHostsFile=/dev/null, StrictHostKeyChecking=no
        config=None,               # -F none: ignore any ssh_config
        keepalive_interval=15,     # ServerAliveInterval=15
    )
    if keyfile:
        opts["client_keys"] = [keyfile]
    if password is not None:
        opts["password"] = password
    if ct:
        opts["connect_timeout"] = int(float(ct))
    # host/port are ignored by our create_connection; pass placeholders.
    return await asyncssh.connect("guest", 22, **opts)


def _open_master(args, env):
    """Establish the one connection and register it under its ControlPath.
    Returns (returncode, merged_output_bytes)."""
    control = _val(args, "-S")
    try:
        conn = _run_sync(_connect(args, env))
    except Exception as exc:  # noqa: BLE001 -- becomes ssh's stderr + nonzero rc
        return 255, f"ssh: connect to host guest port 22: {exc}\n".encode()
    _conns[control] = conn
    # sshdriver checks os.path.exists(control) right after; make it true.
    try:
        open(control, "w").close()
    except OSError:
        pass
    return 0, b""


def _close_master(args):
    control = _oval(args, "ControlPath")
    conn = _conns.pop(control, None)
    if conn is None:
        return 1  # sshdriver logs "Socket already closed" on nonzero, as native
    try:
        conn.close()
        _run_sync(conn.wait_closed())
    except Exception:  # noqa: BLE001
        pass
    try:
        os.remove(control)
    except OSError:
        pass
    return 0


def _conn_for(args):
    return _conns.get(_oval(args, "ControlPath"))


def _exec(args, cmd_tokens):
    """Run a command on the master (a new session/channel). Returns
    (stdout_bytes, stderr_bytes, returncode)."""
    conn = _conn_for(args)
    if conn is None:
        return b"", b"ssh: no control connection\n", 255
    command = " ".join(cmd_tokens)
    try:
        res = _run_sync(conn.run(command, encoding=None))
    except Exception as exc:  # noqa: BLE001
        return b"", f"ssh: {exc}\n".encode(), 255
    rc = res.exit_status
    if rc is None:  # died on a signal
        rc = 255
    return res.stdout, res.stderr, rc


def _scp(args):
    """put/get, over the scp protocol (dropbear has no sftp-server, but execs a
    real scp). Direction is read from which path is remote (user@host:path)."""
    conn = _conn_for(args)
    if conn is None:
        return 1
    recurse = "-r" in args
    # sshdriver always passes the paths last, as `... src dst`; the remote one
    # matches user@host:path (put/get) -- direction follows from which side that is.
    remote_re = re.compile(r"^[^/:]+@[^/:]+:")
    src, dst = args[-2], args[-1]

    def _remote_path(spec):
        return spec.split(":", 1)[1]

    try:
        if remote_re.match(dst):                       # put: local -> remote
            _run_sync(asyncssh.scp(src, (conn, _remote_path(dst)), recurse=recurse))
        elif remote_re.match(src):                     # get: remote -> local
            _run_sync(asyncssh.scp((conn, _remote_path(src)), dst, recurse=recurse))
        else:
            return 1
    except Exception:  # noqa: BLE001
        return 1
    return 0


# --- the Popen / call / run look-alikes -------------------------------------

class _Proc:
    """Enough of subprocess.Popen for sshdriver.py. Every command has already
    run (or, for the keepalive, is represented by the live connection) by the
    time sshdriver inspects it -- there is nothing to actually spawn."""

    def __init__(self, *, returncode=0, stdout=b"", stderr=b"",
                 keepalive_conn=None, encoding=None):
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr
        self._keepalive = keepalive_conn
        self._encoding = encoding
        self.stdin = _DevNull()

    def wait(self, timeout=None):
        return self.returncode

    def communicate(self, input=None, timeout=None):
        out, err = self._stdout, self._stderr
        if self._encoding:  # a text-mode Popen (the keepalive); hand back str
            out = out.decode(self._encoding, "replace") if isinstance(out, bytes) else out
            err = err.decode(self._encoding, "replace") if isinstance(err, bytes) else err
        return (out, err)

    def poll(self):
        # The keepalive process is "alive" exactly while the master is: sshdriver
        # calls this to decide whether the connection is still usable.
        if self._keepalive is not None:
            return None if not self._keepalive.is_closed() else 0
        return self.returncode

    def kill(self):
        pass

    def terminate(self):
        pass


class _DevNull:
    def write(self, data):
        return len(data)

    def close(self):
        pass

    def flush(self):
        pass


def _classify_and_run(args, env):
    """Interpret one ssh/scp argv and perform it. Returns a _Proc."""
    prog = os.path.basename(args[0])

    if prog.endswith("scp"):
        return _Proc(returncode=_scp(args))

    if prog.endswith("ssh"):
        if "-V" in args:  # only reached if explicit_*_mode is set; keep it parseable
            return _Proc(stderr=b"OpenSSH_9.6p1, asyncssh shim\n")

        o = _val(args, "-O")
        if o == "exit":
            return _Proc(returncode=_close_master(args))
        if o in ("forward", "cancel"):
            # No listening sockets in the browser: a failed forward, exactly as
            # native ssh -O forward would report when it cannot bind.
            return _Proc(returncode=1, stderr=b"mux_client_forward: forwarding request failed\n")

        # master open: -M.. plus -S <control>
        if any(a.startswith("-M") for a in args) and _val(args, "-S"):
            rc, out = _open_master(args, env)
            return _Proc(returncode=rc, stdout=out)

        # keepalive: `... <address> cat`, no -l, no -p (address is positional)
        if _val(args, "-l") is None and args and args[-1] == "cat":
            conn = _conn_for(args)
            return _Proc(keepalive_conn=conn, encoding=env.get("encoding") if env else None)

        # a command run over the master: `... -l <user> <address> <cmd...>`
        if _val(args, "-l") is not None:
            # address is the token right after `-l <user>`; the command follows
            li = args.index("-l")
            cmd_tokens = args[li + 3:]
            out, err, rc = _exec(args, cmd_tokens)
            return _Proc(returncode=rc, stdout=out, stderr=err)

    # rsync, sshfs, interact (ssh -t), or anything unrecognised: a host without
    # that tool. sshdriver's callers treat FileNotFoundError as "tool missing".
    raise FileNotFoundError(2, "no such file or directory (no such tool in the browser)")


class _SubprocessShim:
    """The object installed as labgrid.driver.sshdriver.subprocess. Overrides
    the three entry points sshdriver uses and delegates everything else
    (PIPE, DEVNULL, STDOUT, TimeoutExpired, CalledProcessError, ...) to the real
    subprocess module, so `except subprocess.TimeoutExpired` etc. still work."""

    def __getattr__(self, name):
        return getattr(_subprocess, name)

    def Popen(self, args, env=None, encoding=None, **kwargs):
        # sshdriver only text-mode-opens the keepalive; carry the encoding so
        # its communicate() returns str as it expects.
        e = dict(env or {})
        if encoding:
            e["encoding"] = encoding
        proc = _classify_and_run(list(args), e)
        return proc

    def call(self, args, **kwargs):
        return _classify_and_run(list(args), kwargs.get("env")).returncode

    def run(self, args, capture_output=False, text=False, check=False, **kwargs):
        proc = _classify_and_run(list(args), kwargs.get("env"))
        out, err = proc._stdout, proc._stderr
        if text:
            out = out.decode("utf-8", "replace")
            err = err.decode("utf-8", "replace")
        result = _subprocess.CompletedProcess(args, proc.returncode, out, err)
        if check and proc.returncode:
            raise _subprocess.CalledProcessError(proc.returncode, args, out, err)
        return result


def ensure_installed(bridge):
    """Idempotent: wire the bridge, build the loop, and graft the subprocess
    shim onto labgrid's sshdriver module. Called from SSHDriver.on_activate (via
    the wrapper in labgrid_wasm.py), so asyncssh -- imported at the top of this
    module -- is only paid for on the first ssh transition, never at boot."""
    global _bridge, _loop, _installed
    _bridge = bridge
    if _loop is None:
        _loop = SyncLoop(bridge)
    if not _installed:
        import labgrid.driver.sshdriver as _sd
        _sd.subprocess = _SubprocessShim()
        _installed = True
