// The Pyodide worker: stock labgrid lives here, and here it is allowed to block.
//
// Everything labgrid does on the console path is synchronous, so this thread
// parks in Atomics.wait while waiting for QEMU's output. That is exactly why it
// is a worker and not the main thread.

import { RingReader, getNote, setNote, IDLE, RUNNING, STOPPED, SEQ } from "./ringbuffer.js";
import { loadPyodide } from "../../vendor/pyodide/pyodide.mjs";

let pyodide = null;
let reader = null;
let qmpReader = null;
let sshReader = null;
let note = null;
let ctl = null;
// A private namespace for the platform plumbing (the bridge bind, the
// subprocess guard, the REPL console object). It is deliberately NOT __main__:
// the REPL runs in __main__, and everything a name there resolves to should be
// something the human -- or the prompt_startup.py the page echoes line by line
// -- visibly imported. The plumbing's process-global effects still apply; only
// its names stay out of the prompt's reach.
let boot = null;
// Resolves once the SSH backend's packages are loaded (cryptography + asyncssh).
// Kicked off right after "ready" -- off the boot->prompt path -- and awaited by
// the first repl/run so `import asyncssh` in on_activate can never race it. See
// the load just after post("ready"). Null until then; awaiting null is a no-op.
let sshBackendReady = null;

const post = (msg) => self.postMessage(msg);
const status = (text) => post({ type: "status", text });

// --- the object labgrid_wasm.py binds against -------------------------------

const bridge = {
  qemuVersion: "0.0.0",

  /** Start QEMU-WASM with labgrid's argv. Returns null, or an error string. */
  startQemu(argv) {
    setNote(note, "");
    post({ type: "start-qemu", argv: Array.from(argv) });
    return waitForState(60_000);
  },

  stopQemu() {
    post({ type: "stop-qemu" });
  },

  /**
   * Block up to timeoutMs for console bytes. Returns a Uint8Array, or undefined
   * on timeout -- deliberately undefined and not null, because Pyodide maps JS
   * null to its own JsNull singleton, which is not Python's None and would slip
   * straight past an `is None` check.
   */
  readConsole(timeoutMs, maxBytes) {
    const chunk = reader.read(maxBytes, timeoutMs);
    if (!chunk) return undefined;
    post({ type: "consumed" }); // release any deferred flow-control ack
    return chunk;
  },

  writeConsole(bytes) {
    post({ type: "tx", bytes: Array.from(bytes) });
  },

  /** Same contract as readConsole, for the QMP monitor channel. */
  readQmp(timeoutMs, maxBytes) {
    return qmpReader.read(maxBytes, timeoutMs) || undefined;
  },

  writeQmp(bytes) {
    post({ type: "qmp-tx", bytes: Array.from(bytes) });
  },

  /** Same contract as readConsole/readQmp, for the SSHDriver's serial channel.
   * labgrid_wasm_ssh's event loop blocks here (Atomics.wait in the ring) while
   * asyncssh waits for the guest's dropbear, exactly as the console reader does. */
  readSsh(timeoutMs, maxBytes) {
    return sshReader.read(maxBytes, timeoutMs) || undefined;
  },

  writeSsh(bytes) {
    post({ type: "ssh-tx", bytes: Array.from(bytes) });
  },

  /**
   * Stage `bytes` so the guest can download them from the stack's gateway host
   * via the in-browser proxy. HTTPProviderDriver.stage() (labgrid_wasm.py) calls
   * this; the main thread holds the bytes and serves them from the guest's
   * fetch (see browsernet.js). A typed array, not Array.from(), because a bundle
   * is large and slice() just hands postMessage a clean copy to clone.
   */
  stageFile(name, bytes) {
    post({ type: "stage-file", name, bytes: bytes.slice() });
  },

  /**
   * Put the console line discipline into raw mode (on=true) or back to cooked.
   * ShellDriver.get()/put() drive XMODEM, a binary protocol, over the console;
   * the page's xterm-pty is a second line discipline in series with the guest's
   * own tty, and its cooked default would corrupt the byte stream. labgrid flips
   * it raw for the duration of a transfer and cooked again after (labgrid_wasm
   * wraps _get_bytes/_put_bytes). Fire-and-forget: it is a postMessage, ordered
   * ahead of the writeConsole/tx postMessages that follow it.
   */
  setConsoleRaw(on) {
    post({ type: "set-raw", on: !!on });
  },
};

/** Park until the main thread reports QEMU running or dead. */
function waitForState(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = reader.state;
    if (state === RUNNING) return null;
    if (state === STOPPED) return getNote(note) || "QEMU-WASM exited during startup";

    const seq = Atomics.load(ctl, SEQ);
    if (reader.state !== IDLE) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timed out waiting for QEMU-WASM to start";
    Atomics.wait(ctl, SEQ, seq, remaining);
  }
}

// --- fetching the user's own files into pyodide's filesystem ----------------

// Where the environment config and everything it refers to live in Pyodide's
// filesystem. It has to be a real path, not a notional one: labgrid resolves
// imports: against the directory of the config file (Config.resolve_path) and
// then loads them by that exact path (Environment.__attrs_post_init__ ->
// SourceFileLoader), so the demo/ directory on the server is mirrored here.
const DEMO_DIR = "/demo";

async function fetchDemoFile(base, name) {
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`demo/${name}: HTTP ${res.status}`);
  const path = DEMO_DIR + "/" + name;
  const slash = path.lastIndexOf("/");
  if (slash > DEMO_DIR.length) pyodide.FS.mkdirTree(path.slice(0, slash));
  pyodide.FS.writeFile(path, await res.text());
  return path;
}

/**
 * Fetch the Python modules the environment's imports: key names.
 *
 * A static server has no directory listing, so the file names have to come from
 * somewhere -- and the config already lists them. labgrid's own Config does the
 * parsing (it knows about !template and about resolving relative paths), so
 * this stays a lookup rather than a second, subtly different implementation.
 */
async function fetchEnvImports(base) {
  const paths = JSON.parse(
    await pyodide.runPythonAsync(`
import json
from labgrid.config import Config
json.dumps([p for p in Config("${DEMO_DIR}/env.yaml").get_imports() if p.endswith(".py")])
`, { globals: boot }),
  );
  for (const path of paths) {
    if (!path.startsWith(DEMO_DIR + "/")) {
      // Anything outside demo/ has no URL to be fetched from. Non-.py entries
      // are plain module names and were filtered out above, so this is a path
      // that escaped the config directory -- let labgrid report it itself.
      post({ type: "stderr", line: `imports: ${path} is outside ${DEMO_DIR}/, not fetched` });
      continue;
    }
    const name = path.slice(DEMO_DIR.length + 1);
    await fetchDemoFile(base, name);
  }
  return paths;
}

// --- boot -------------------------------------------------------------------

async function init(msg) {
  reader = new RingReader(msg.ring);
  qmpReader = new RingReader(msg.qmpRing);
  sshReader = new RingReader(msg.sshRing);
  ctl = new Int32Array(msg.ring.ctl);
  note = msg.note;
  bridge.qemuVersion = msg.qemuVersion;

  status("loading pyodide");
  pyodide = await loadPyodide({
    indexURL: new URL("../../vendor/pyodide/", import.meta.url).href,
    stdout: (line) => post({ type: "stdout", line }),
    stderr: (line) => post({ type: "stderr", line }),
  });
  status("loading packages");
  // Resolved through pyodide's own lock, so they come from vendor/pyodide/ next
  // to it rather than through micropip. micropip has to arrive this way -- it is
  // what does everything below -- and attrs and pyyaml are built as part of the
  // pyodide distribution (pyyaml is a compiled wasm32 wheel, not something pip
  // could produce here). protobuf and exceptiongroup are for labgrid's pytest
  // plugin, which reaches labgrid.remote: protobuf has to be genuine, because
  // the generated coordinator stubs build their descriptors at import.
  await pyodide.loadPackage(
    ["micropip", "attrs", "pyyaml", "protobuf", "exceptiongroup"]);
  const micropip = pyodide.pyimport("micropip");

  // Stage everything else the Python side fetches now, before the wheels, so
  // that once the wheels are in nothing but CPU stands between here and
  // "ready" -- the page starts QEMU's 27 MB of downloads at that point, and a
  // small fetch issued behind them on a shared slow link waits seconds.
  //
  // grpc_stub.py lands as grpc.py: grpcio has no wasm build, and labgrid's
  // pytest plugin imports it by way of labgrid.remote. Nothing calls into it --
  // see the module's own comment.
  const py = new URL("../python/", import.meta.url).href;
  for (const [name, as] of [["labgrid_wasm.py", "labgrid_wasm.py"],
                            ["labgrid_wasm_ssh.py", "labgrid_wasm_ssh.py"],
                            ["grpc_stub.py", "grpc.py"]]) {
    const src = await (await fetch(py + name)).text();
    pyodide.FS.writeFile("/lib/python3.14/site-packages/" + as, src);
  }
  // the shims are plain files too; put them where labgrid_wasm expects them.
  // They come from build/, not from runtime/python/, because setup.sh generates
  // them from the host's own libc on every run.
  const shims = new URL("../../shims/", import.meta.url).href;
  pyodide.FS.mkdirTree("/lib/python3.14/site-packages/shims");
  for (const name of ["termios.py", "fcntl.py", "resource.py"]) {
    const src = await (await fetch(shims + name)).text();
    pyodide.FS.writeFile("/lib/python3.14/site-packages/shims/" + name, src);
  }

  // fetch the demo's environment and script where labgrid expects them
  const demo = new URL("../../demo/", import.meta.url).href;
  pyodide.FS.mkdirTree(DEMO_DIR);
  // conftest.py, pytest.ini and test_demo.py are the pytest half of the demo;
  // see the PYTEST_DISABLE_PLUGIN_AUTOLOAD note below. The suite is a single
  // file next to the config (no tests/ subdir, no testpaths), so a bare
  // pytest.main() at the prompt discovers it from the rootdir.
  for (const name of ["env.yaml", "prompt_startup.py", "conftest.py", "pytest.ini",
                      "test_demo.py",
                      // the demo SSH keypair: ShellDriver deploys the .pub to the
                      // guest's authorized_keys at the shell transition; SSHDriver
                      // authenticates with the private key at the ssh transition.
                      "keys/demo_ed25519", "keys/demo_ed25519.pub"]) {
    await fetchDemoFile(demo, name);
  }

  // The RAUC bundle the streaming test installs. Binary, and it lives with the
  // guest images rather than under demo/, so main.js passes its URL (only with
  // networking on). It lands at the path env.yaml's `images: rauc_bundle`
  // resolves to, which is the file HTTPProviderDriver.stage() reads and streams
  // back to the guest over the in-browser proxy.
  if (msg.raucBundleUrl) {
    const res = await fetch(msg.raucBundleUrl);
    if (!res.ok) throw new Error(`rauc bundle: HTTP ${res.status}`);
    pyodide.FS.mkdirTree(DEMO_DIR + "/images/rauc");
    pyodide.FS.writeFile(DEMO_DIR + "/images/rauc/demo.raucb",
                         new Uint8Array(await res.arrayBuffer()));
  }

  status("installing labgrid and pytest");
  // labgrid with its whole dependency closure, plus pytest for the human at
  // the REPL, all from this tree. setup.sh let pip resolve the closures and
  // listed them in index.txt (names, not versions: the labgrid wheel's carries
  // whatever setuptools_scm derived from the pinned commit). The page
  // therefore fetches nothing from anywhere but its own host.
  //
  // deps=False because the list is already complete, and because resolution
  // could not succeed anyway: labgrid declares fourteen hard requirements, one
  // of them grpcio, which publishes no pure-python wheel and has no Emscripten
  // build. (pyudev and pyusb are often blamed for this and are innocent: both
  // ship py3-none-any wheels and would install fine. They would simply never
  // work, having nothing to bind to.) Nothing in the import closure of
  // `import labgrid` reaches any of them -- grpcio is only used by
  // labgrid.remote, which labgrid's pytest plugin does import, and which the
  // grpc stub placed below covers.
  //
  // callKwargs, not a trailing object: a plain object would bind to micropip's
  // next positional parameter (keep_going) and deps would silently stay True.
  const wheels = new URL("../../vendor/wheels/", import.meta.url).href;
  const wheelNames = (await (await fetch(wheels + "index.txt")).text()).trim().split("\n");
  await micropip.install.callKwargs(wheelNames.map((name) => wheels + name), { deps: false });
  // Everything the Python side downloads is in (interpreter, stdlib, packages,
  // wheels); what is left before "ready" is CPU and a few KB of demo files. The
  // page starts QEMU's own downloads here, behind them rather than alongside:
  // on a shared slow link the 27 MB of QEMU and network stack would otherwise
  // starve the wheels and push "ready" out by seconds (main.js, prepareQemu).
  post({ type: "downloads-done" });

  status("starting QEMU and binding QEMUDriver");
  globalThis.labgridBridge = bridge;
  // All of this runs in the private `boot` namespace, not __main__: its names
  // (labgrid_wasm, os, subprocess, sys) must not appear at the prompt, where
  // only what the human imported should. Its effects are process-global, so the
  // bind, the Popen guard, sys.executable and the chdir all take hold anyway.
  boot = pyodide.toPy({});
  await pyodide.runPythonAsync(`
import labgrid_wasm
from js import labgridBridge
labgrid_wasm.bind(labgridBridge)

# Two platform quirks stand between labgrid's pytest plugin and a browser, both
# about emscripten rather than about labgrid:
#
#   grpc, imported at module level by labgrid.remote and placed above as a stub
#   that satisfies the import and nothing else, and
#
#   subprocess, which emscripten cannot do at all. The env fixture shells out to
#   git for provenance metadata and handles a missing binary, but emscripten
#   raises a bare OSError that its except clauses miss, which errors every test
#   in the session. Popen is the choke point for check_output and run alike, and
#   FileNotFoundError is both true here and the case callers already handle.
#   QEMU is unaffected: labgrid_wasm binds on_activate, so it never spawns.
import os
import subprocess

def _no_subprocesses(*args, **kwargs):
    raise FileNotFoundError(2, "no such file or directory (emscripten has no processes)")

subprocess.Popen = _no_subprocesses

# There is no interpreter on disk to name, and emscripten's placeholder argv[0]
# leaves sys.executable as /home/pyodide/this.program, which pytest prints in its
# header from -v up and which reads as a leaked build artifact. Nothing here can
# act on the value -- its only other callers spawn it, and Popen is gone -- so
# name the thing that is actually running the code.
import sys
sys.executable = "pyodide"

# Run from the config's own directory, the way a checkout is worked in, so that
# pytest.ini is found and its --lg-env resolves when the human runs
# pytest.main() at the prompt. pytest itself is not imported here: it is not
# needed until then, and a name usable at the prompt should be one the human
# imported (as the page's examples show: import pytest, then pytest.main()).
os.chdir("/demo")
`, { globals: boot });

  await fetchEnvImports(demo);

  // The REPL is pyodide's PyodideConsole -- Python's own
  // code.InteractiveConsole underneath -- so it behaves like the real thing:
  // line-by-line input with "..." continuation, reprs from the displayhook,
  // real tracebacks, tab completion, even top-level await. It runs in
  // __main__'s namespace, the same one "run" messages use, so what
  // prompt_startup.py defines the human can use. Its stdout/stderr are captured per-push and
  // stream to the page as chunks, which keeps output live while a blocking
  // call (a transition, say) is still running.
  globalThis.__replStdout = (text) => post({ type: "repl-stream", stream: "stdout", text });
  globalThis.__replStderr = (text) => post({ type: "repl-stream", stream: "stderr", text });
  // Also in `boot`: the console drives __main__ (see PyodideConsole below), so
  // the prompt's namespace is __main__ and stays clean, while the console
  // object and __repl_* helpers live out of its sight.
  const versions = await pyodide.runPythonAsync(`
import __main__
from js import __replStdout, __replStderr
from pyodide.console import PyodideConsole

__repl_console = PyodideConsole(
    __main__.__dict__, stdout_callback=__replStdout, stderr_callback=__replStderr)

def __repl_complete(source):
    import json
    completions, start = __repl_console.complete(source)
    return json.dumps({"completions": completions, "start": start})

async def __repl_push(line):
    import json
    from pyodide.console import repr_shorten
    fut = __repl_console.push(line)
    if fut.syntax_check == "incomplete":
        return json.dumps({"status": "incomplete"})
    if fut.syntax_check == "syntax-error":
        return json.dumps({"status": "error", "text": fut.formatted_error or "SyntaxError"})
    try:
        value = await fut
    except BaseException:
        return json.dumps({"status": "error", "text": fut.formatted_error or "internal error"})
    return json.dumps(
        {"status": "ok", "repr": None if value is None else repr_shorten(value)})

import sys
from importlib.metadata import version as __dist_version
f"{sys.version.split()[0]}|{__dist_version('labgrid')}"
`, { globals: boot });
  const [pyVersion, labgridVersion] = versions.split("|");
  const banner =
    `Python ${pyVersion} (Pyodide ${pyodide.version}) on wasm32 -- ` +
    `labgrid ${labgridVersion}, QEMU ${bridge.qemuVersion} (WebAssembly)`;

  post({ type: "ready", banner }); // the banner is the "ready" the human sees

  // The SSH backend, loaded now rather than before "ready": cryptography and
  // asyncssh are only needed once a strategy enters the ssh state, and a human
  // cannot type in the ~0.25 s this takes -- so it costs the prompt nothing and
  // is visible only to a harness measuring page->on(). The first repl/run awaits
  // sshBackendReady, so `import asyncssh` in SSHDriver.on_activate cannot run
  // before the wheels are in. cryptography (with cffi/pycparser/six) comes from
  // the pyodide lock via loadPackage; asyncssh is a pure-python wheel installed
  // by micropip from vendor/asyncssh/ -- its own index.txt, as vendor/wheels/
  // has, so setup.sh's pin is the one place the version lives, and a directory
  // of its own so boot does not install it. The larger `import asyncssh` cost
  // stays deferred to on_activate itself.
  const sshWheels = new URL("../../vendor/asyncssh/", import.meta.url).href;
  sshBackendReady = (async () => {
    await pyodide.loadPackage(["cryptography", "typing-extensions"]);
    const names = (await (await fetch(sshWheels + "index.txt")).text()).trim().split("\n");
    await micropip.install.callKwargs(names.map((name) => sshWheels + name), { deps: false });
  })().catch((err) => post({ type: "stderr", line: `ssh backend load failed: ${err}` }));
}

/** Run fn and post its return value back to the main thread as this command's
 * result; a throw becomes {ok:false}. Every worker command shares this shape. */
async function respond(id, fn) {
  try {
    post({ type: "result", id, ok: true, value: await fn() });
  } catch (err) {
    post({ type: "result", id, ok: false, error: String(err) });
  }
}

const run = (msg) => respond(msg.id, async () => {
  if (sshBackendReady) await sshBackendReady; // ssh backend in before any code runs
  const value = await pyodide.runPythonAsync(msg.code);
  // Only structured-cloneable values survive postMessage. Python objects that
  // do not convert cleanly (a re.Match from expect(), say) would otherwise fail
  // with an opaque DataCloneError, so fall back to their repr.
  try {
    const out = value?.toJs ? value.toJs({ create_pyproxies: false }) : value;
    structuredClone(out);
    return out;
  } catch {
    return String(value);
  }
});

const repl = (msg) => respond(msg.id, async () => {
  if (sshBackendReady) await sshBackendReady; // ssh backend in before the first line
  boot.set("__repl_line", msg.code);
  return pyodide.runPythonAsync("await __repl_push(__repl_line)", { globals: boot });
});

const replComplete = (msg) => respond(msg.id, () => {
  boot.set("__repl_source", msg.source);
  return pyodide.runPythonAsync("__repl_complete(__repl_source)", { globals: boot });
});

/**
 * Put a file into the filesystem, and forget any module that came from it.
 *
 * pytest caches test modules in sys.modules, so without the second half a
 * re-run would collect the file again and quietly execute the old code.
 * Matching on __file__ rather than guessing the module name keeps that true
 * whatever import mode pytest resolved it under.
 */
const writeFile = (msg) => respond(msg.id, async () => {
  pyodide.FS.writeFile(msg.path, msg.source);
  boot.set("__written_path", msg.path);
  await pyodide.runPythonAsync(`
import sys
for __name in [n for n, m in list(sys.modules.items())
               if getattr(m, "__file__", None) == __written_path]:
    del sys.modules[__name]
del __written_path
`, { globals: boot });
  return msg.path;
});

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") await init(msg);
    else if (msg.type === "run") await run(msg);
    else if (msg.type === "repl") await repl(msg);
    else if (msg.type === "repl-complete") await replComplete(msg);
    else if (msg.type === "write-file") await writeFile(msg);
  } catch (err) {
    post({ type: "fatal", error: String(err) + "\n" + (err && err.stack) });
  }
};
