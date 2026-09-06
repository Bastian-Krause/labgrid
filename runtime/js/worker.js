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
let note = null;
let ctl = null;

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

// --- staging the user's own files -------------------------------------------

// Where the environment config and everything it refers to live in Pyodide's
// filesystem. It has to be a real path, not a notional one: labgrid resolves
// imports: against the directory of the config file (Config.resolve_path) and
// then loads them by that exact path (Environment.__attrs_post_init__ ->
// SourceFileLoader), so the demo/ directory on the server is mirrored here.
const DEMO_DIR = "/demo";

async function stageDemoFile(base, name) {
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
async function stageEnvImports(base) {
  const paths = JSON.parse(
    await pyodide.runPythonAsync(`
import json
from labgrid.config import Config
json.dumps([p for p in Config("${DEMO_DIR}/env.yaml").get_imports() if p.endswith(".py")])
`),
  );
  for (const path of paths) {
    if (!path.startsWith(DEMO_DIR + "/")) {
      // Anything outside demo/ has no URL to be fetched from. Non-.py entries
      // are plain module names and were filtered out above, so this is a path
      // that escaped the config directory -- let labgrid report it itself.
      post({ type: "stderr", line: `imports: ${path} is outside ${DEMO_DIR}/, not staged` });
      continue;
    }
    const name = path.slice(DEMO_DIR.length + 1);
    status("staging " + name);
    await stageDemoFile(base, name);
  }
  return paths;
}

// --- boot -------------------------------------------------------------------

async function init(msg) {
  reader = new RingReader(msg.ring);
  qmpReader = new RingReader(msg.qmpRing);
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
  // grpc stub staged below covers.
  //
  // callKwargs, not a trailing object: a plain object would bind to micropip's
  // next positional parameter (keep_going) and deps would silently stay True.
  const wheels = new URL("../../vendor/wheels/", import.meta.url).href;
  const wheelNames = (await (await fetch(wheels + "index.txt")).text()).trim().split("\n");
  await micropip.install.callKwargs(wheelNames.map((name) => wheels + name), { deps: false });

  status("binding QEMUDriver");
  // grpc_stub.py lands as grpc.py: grpcio has no wasm build, and labgrid's
  // pytest plugin imports it by way of labgrid.remote. Nothing calls into it --
  // see the module's own comment.
  const py = new URL("../python/", import.meta.url).href;
  for (const [name, as] of [["labgrid_wasm.py", "labgrid_wasm.py"],
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

  // stage the demo's environment and script where labgrid expects them
  const demo = new URL("../../demo/", import.meta.url).href;
  pyodide.FS.mkdirTree(DEMO_DIR);
  // conftest.py, pytest.ini and tests/ are the pytest half of the demo; see the
  // PYTEST_DISABLE_PLUGIN_AUTOLOAD note below. stageDemoFile mkdirTree's the
  // nested path, so tests/ needs nothing extra.
  for (const name of ["env.yaml", "demo.py", "conftest.py", "pytest.ini",
                      "tests/test_demo.py"]) {
    await stageDemoFile(demo, name);
  }

  globalThis.labgridBridge = bridge;
  await pyodide.runPythonAsync(`
import labgrid_wasm
from js import labgridBridge
labgrid_wasm.bind(labgridBridge)

# pytest is vendored so the demo can run a real labgrid suite from the prompt,
# with labgrid's own [pytest11] plugin -- fixtures, markers, the -v levels, all
# of it. Two things stand between that plugin and a browser, and both are about
# the platform rather than about labgrid:
#
#   grpc, imported at module level by labgrid.remote and staged above as a stub
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

# Run from the config's own directory, the way a checkout is worked in, so
# pytest.ini is found and its --lg-env resolves; pytest.main() alone is then
# the whole invocation at the prompt.
os.chdir("/demo")
import pytest
`);

  await stageEnvImports(demo);

  // The REPL is pyodide's PyodideConsole -- Python's own
  // code.InteractiveConsole underneath -- so it behaves like the real thing:
  // line-by-line input with "..." continuation, reprs from the displayhook,
  // real tracebacks, tab completion, even top-level await. It runs in
  // __main__'s namespace, the same one "run" messages use, so what demo.py
  // defines the human can use. Its stdout/stderr are captured per-push and
  // stream to the page as chunks, which keeps output live while a blocking
  // call (a transition, say) is still running.
  globalThis.__replStdout = (text) => post({ type: "repl-stream", stream: "stdout", text });
  globalThis.__replStderr = (text) => post({ type: "repl-stream", stream: "stderr", text });
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
`);
  const [pyVersion, labgridVersion] = versions.split("|");
  const banner =
    `Python ${pyVersion} (Pyodide ${pyodide.version}) on wasm32 -- ` +
    `labgrid ${labgridVersion}, QEMU ${bridge.qemuVersion} (WebAssembly)`;

  post({ type: "ready", banner }); // the banner is the "ready" the human sees
}

async function run(msg) {
  try {
    const value = await pyodide.runPythonAsync(msg.code);
    // Only structured-cloneable values survive postMessage. Python objects that
    // do not convert cleanly (a re.Match from expect(), say) would otherwise
    // fail with an opaque DataCloneError, so fall back to their repr.
    let out;
    try {
      out = value?.toJs ? value.toJs({ create_pyproxies: false }) : value;
      structuredClone(out);
    } catch {
      out = String(value);
    }
    post({ type: "result", id: msg.id, ok: true, value: out });
  } catch (err) {
    post({ type: "result", id: msg.id, ok: false, error: String(err) });
  }
}

async function repl(msg) {
  try {
    pyodide.globals.set("__repl_line", msg.code);
    const out = await pyodide.runPythonAsync("await __repl_push(__repl_line)");
    post({ type: "result", id: msg.id, ok: true, value: out });
  } catch (err) {
    post({ type: "result", id: msg.id, ok: false, error: String(err) });
  }
}

/**
 * Put a file into the filesystem, and forget any module that came from it.
 *
 * pytest caches test modules in sys.modules, so without the second half a
 * re-run would collect the file again and quietly execute the old code.
 * Matching on __file__ rather than guessing the module name keeps that true
 * whatever import mode pytest resolved it under.
 */
async function writeFile(msg) {
  try {
    pyodide.FS.writeFile(msg.path, msg.source);
    pyodide.globals.set("__written_path", msg.path);
    await pyodide.runPythonAsync(`
import sys
for __name in [n for n, m in list(sys.modules.items())
               if getattr(m, "__file__", None) == __written_path]:
    del sys.modules[__name]
del __written_path
`);
    post({ type: "result", id: msg.id, ok: true, value: msg.path });
  } catch (err) {
    post({ type: "result", id: msg.id, ok: false, error: String(err) });
  }
}

async function replComplete(msg) {
  try {
    pyodide.globals.set("__repl_source", msg.source);
    const out = await pyodide.runPythonAsync("__repl_complete(__repl_source)");
    post({ type: "result", id: msg.id, ok: true, value: out });
  } catch (err) {
    post({ type: "result", id: msg.id, ok: false, error: String(err) });
  }
}

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
