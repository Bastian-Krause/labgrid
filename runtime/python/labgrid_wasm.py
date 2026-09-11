"""Make labgrid's stock QEMUDriver talk to QEMU-WASM instead of a host QEMU.

labgrid itself is unmodified -- a wheel built from an untouched upstream
checkout. This module does three things, all from outside the package:

1. Puts the generated stdlib shims (termios, fcntl, resource) on sys.path, so
   that `import labgrid` -- and the pty/tty/pexpect/ptyprocess/pyserial chain
   underneath it -- works at all in Pyodide.

2. Grafts five methods onto labgrid.driver.QEMUDriver: the ones that talk to a
   POSIX host. Everything else is inherited stock -- including on(), off(),
   cycle(), monitor_command() and add_port_forward(), which are pure QMP calls
   and need no help at all -- as are get_qemu_base_args() (which builds the real
   QEMU command line from the YAML), the whole ConsoleExpectMixin
   expect/sendline machinery, and the target_factory registration. The object in
   the target genuinely is QEMUDriver: the YAML says QEMUDriver, isinstance()
   holds, and repr() is unchanged.

3. Grafts one method, stage(), onto labgrid.driver.HTTPProviderDriver. Stock
   stage() rsyncs the file into an HTTP docroot on the provider's host; there is
   no host and no rsync here, so it instead hands the bytes to the page, which
   serves them to the guest over the in-browser proxy at the provider's external
   URL (see runtime/js/browsernet.js). get_export_vars() and the resource stay
   stock, so the URL the guest streams from is the one the YAML declares.

The replacements live in the _QEMUDriverWasm and _HTTPProviderWasm holder
classes below, one per stock class they patch, purely so they read as a group.
The holders are never instantiated: bind() copies their methods onto the stock
classes with _graft() and wires up the JS bridge they close over.

This is written against labgrid master, where on_activate() starts the QEMU
process and opens the QMP monitor, leaving on() as nothing but "cont". In the
26.0 release the process start lives in on() instead, which would mean grafting
on() and off() as well -- seven methods rather than five. setup.sh pins the
commit this was built against.

Beyond the five methods, the only private state touched is self.qmp, which stock
labgrid sets in the same place.

Import this before any user code. Nothing in the demo scripts refers to it.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def install_shims(path=None):
    """Put the stdlib shims first on sys.path. Must run before `import labgrid`."""
    path = path or os.path.join(_HERE, "shims")
    if path not in sys.path:
        sys.path.insert(0, path)
    return path


install_shims()

# labgrid (and the pexpect/pyodide bits the methods need) are importable now that
# the shims are on the path. The holder classes below reference the stock classes
# in their decorators, so these have to be module-level rather than deferred.
from pexpect import TIMEOUT  # noqa: E402
from pyodide.ffi import to_js  # noqa: E402

from labgrid.driver import HTTPProviderDriver, QEMUDriver  # noqa: E402
from labgrid.driver.common import Driver  # noqa: E402
from labgrid.step import step  # noqa: E402
from labgrid.util.qmp import QMPMonitor  # noqa: E402

#: The JS object worker.js exports (the SharedArrayBuffer ring to the main thread
#: and the QEMU-WASM module lifecycle). Set once by bind(); the grafted methods
#: read it as a module global rather than a closure so they can live out here.
_bridge = None


class QemuWasmError(Exception):
    """QEMU-WASM failed to start, or exited unexpectedly."""


class _QmpReader:
    """The read half of labgrid's QMPMonitor: line-oriented, blocking, bytes.

    labgrid/util/qmp.py only ever calls readline(), so that is all this provides.
    """

    def __init__(self, bridge, timeout=60.0):
        self._bridge = bridge
        self._timeout = timeout
        self._buf = b""

    def readline(self):
        while b"\n" not in self._buf:
            chunk = self._bridge.readQmp(int(self._timeout * 1000), 4096)
            if chunk is None or not hasattr(chunk, "to_py"):
                # QMPMonitor turns an empty read into QMPError("Received empty
                # response"), which is the right thing for a monitor that stopped
                # answering.
                return b""
            self._buf += bytes(chunk.to_py())
        line, _, self._buf = self._buf.partition(b"\n")
        return line + b"\n"


class _QmpWriter:
    """The write half: QMPMonitor calls write() with bytes, then flush()."""

    def __init__(self, bridge, to_js):
        self._bridge = bridge
        self._to_js = to_js

    def write(self, data):
        self._bridge.writeQmp(self._to_js(list(data)))
        return len(data)

    def flush(self):
        pass


class _QEMUDriverWasm:
    """The five QEMUDriver methods that talk to a POSIX host, re-aimed at
    QEMU-WASM. Grafted onto the stock QEMUDriver by bind(); never instantiated,
    so `self` is always the stock driver."""

    def get_qemu_version(self, qemu_bin):
        # Stock runs `qemu-system-* -version` in a subprocess. The version of the
        # QEMU that was compiled to WebAssembly is fixed at build time and is
        # published by the page instead.
        return tuple(int(part) for part in str(_bridge.qemuVersion).split("."))

    def on_activate(self):
        # Mirrors stock: build the command line, start QEMU paused, and open the
        # QMP monitor -- so on(), off() and cycle() are inherited untouched and
        # are nothing but real QMP calls.
        #
        # get_qemu_base_args() is labgrid's own and is used verbatim: it turns the
        # YAML's machine/cpu/memory/kernel/dtb/disk/... into a real QEMU command
        # line. The socket setup stock does here has no browser equivalent and is
        # simply absent; argv[0] is the qemu binary path, which Emscripten
        # ignores, and the page appends the QMP chardev as a transport detail.
        argv = self.get_qemu_base_args()[1:]
        argv.append("-S")  # stock does this too: start paused, on() sends cont
        self.logger.debug("starting QEMU-WASM with: %s", argv)

        error = _bridge.startQemu(to_js(argv))
        if error:
            raise QemuWasmError(str(error))

        # Stock builds this over the child's stdio pipes; here it runs over a
        # second Emscripten character device (see runtime/js/qmpchannel.js). Either way
        # it is real QMP against real QEMU.
        self.qmp = QMPMonitor(_QmpReader(_bridge), _QmpWriter(_bridge, to_js))

    def on_deactivate(self):
        # Stock sends QMP "quit" and reaps the child. QEMU-WASM's
        # PROXY_TO_PTHREAD runtime cannot be torn down and restarted inside a
        # page, so "quit" would be a one-way door. Halting the guest is the
        # closest honest equivalent; the page is finished either way.
        if getattr(self, "qmp", None) is not None and self.status:
            self.monitor_command("stop")
            self.status = 0
        _bridge.stopQemu()
        self.qmp = None

    def _read(self, size=1, timeout=10, max_size=None):
        # Matches stock behaviour: return whatever has arrived, up to a page, and
        # raise pexpect.TIMEOUT if nothing arrives in time. The size argument is
        # ignored (stock reads a full page too), but max_size still caps it.
        size = min(max_size, 4096) if max_size else 4096
        chunk = _bridge.readConsole(int(timeout * 1000), size)
        # Belt and braces: JS undefined arrives as None, but a JS null would
        # arrive as pyodide's JsNull, which is not None and has no .to_py().
        if chunk is None or not hasattr(chunk, "to_py"):
            raise TIMEOUT(f"Timeout of {timeout:.2f} seconds exceeded")
        return bytes(chunk.to_py())

    def _write(self, data):
        _bridge.writeConsole(to_js(list(data)))
        return len(data)


class _HTTPProviderWasm:
    """HTTPProviderDriver.stage(), serving the file from the browser instead of
    rsync'ing it to an HTTP docroot. Grafted onto the stock HTTPProviderDriver."""

    # Same signature, same @check_active/@step, and the same return contract as
    # stock (external URL + basename); only the delivery differs. The bytes go
    # over to JS as a Uint8Array; the guest fetches them back through the proxy.
    @Driver.check_active
    @step(args=["filename"], result=True)
    def stage(self, filename):
        name = os.path.basename(filename)
        with open(filename, "rb") as fh:
            _bridge.stageFile(name, to_js(fh.read()))
        return self.provider.external.rstrip("/") + "/" + name


def _graft(holder, target):
    """Copy a holder class's methods onto a stock labgrid class. Keyed by each
    method's defined name, so decorators that do not preserve __name__ are fine;
    dunders (and the holder's docstring) are skipped."""
    for name, attr in vars(holder).items():
        if not name.startswith("__"):
            setattr(target, name, attr)


def bind(bridge):
    """Wire the JS bridge into the grafted methods and copy them onto the stock
    classes. `bridge` is the object worker.js exports. Call once, before any
    driver is activated.
    """
    global _bridge
    _bridge = bridge
    _graft(_QEMUDriverWasm, QEMUDriver)
    _graft(_HTTPProviderWasm, HTTPProviderDriver)
    return QEMUDriver
