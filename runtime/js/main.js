// Page side: the terminal, the console bridge, and the QEMU-WASM lifecycle.
//
// The bridge taps the *master* side of the pty, which is where a human at a
// terminal sits -- and labgrid is just a second human. Master.activate() does
// exactly two things (onWrite towards the terminal, ldisc.writeFromLower away
// from it), so we do those two things ourselves and splice labgrid in. That
// leaves Module.pty as the untouched xterm-pty Slave, so emscripten-pty.js and
// the TTY poll patch behave exactly as they do upstream.

import { createRing, createNote, RingWriter, setNote, IDLE, RUNNING, STOPPED } from "./ringbuffer.js";
import { createQmpChannel } from "./qmpchannel.js";
import { fetchGuestManifest, stageGuestFiles } from "./guestfs.js";
import { initEditors } from "./editor.js";
import { createFakeQmp, startFakeConsole } from "./fakeguest.js";

const QEMU_VERSION = "8.2.0"; // reported by the wasm build's own QMP greeting

// ?replay=1 swaps the guest for a recorded boot log and a scripted shell, so
// the bridge and the labgrid stack above it can be tested in seconds rather
// than minutes. Everything below the guest stays the production path -- see
// js/fakeguest.js for what that does and does not prove.
const REPLAY = new URLSearchParams(location.search).get("replay");
const REPLAY_FIXTURE = REPLAY && REPLAY !== "1" ? REPLAY : "./fixtures/boot.json";

const statusEl = document.getElementById("status");
const state = {
  status: "starting",
  ready: false,
  results: {},
  errors: [],
};

// The guest console, kept as chunks rather than one growing string. Appending to
// a string here is O(n) per chunk, and with a 100 KB boot log that turns into
// tens of megabytes of copying on the main thread -- which starves the Emscripten
// proxy queue that QEMU's QMP and TTY I/O both depend on, and the monitor simply
// stops answering. Join lazily instead, only when something actually reads it.
const consoleChunks = [];
let consoleCache = null;
Object.defineProperty(state, "console", {
  get() {
    if (consoleCache === null) consoleCache = consoleChunks.join("");
    return consoleCache;
  },
});
window.__demo = state;

// Bridge state, so a failure dump shows *why* rather than just what.
const counters = { ttyPoll: 0, qmpInCall: 0, qmpInBytes: 0, qmpOutBytes: 0 };
state.counters = counters;

state.probe = () => ({
  ...counters,
  guest: guest.mode && `${guest.mode}${guest.done ? "" : " (incomplete)"}: ` +
    guest.files.map((f) => `${f.path} ${f.size}`).join(", "),
  consoleFree: writer.free,
  consoleUnread: ring ? new Int32Array(ring.ctl)[1] - new Int32Array(ring.ctl)[2] : null,
  ackDeferred: deferredAck !== null,
  qmpFree: qmpWriter.free,
  qmpUnread: new Int32Array(qmpRing.ctl)[1] - new Int32Array(qmpRing.ctl)[2],
  qmpToQemuPending: qmp ? qmp.toQemu.length : null,
  qmpFromQemuBytes: qmp ? qmp.fromQemu.length : null,
});

/** The machine-readable status; tests and probes poll window.__demo.status. */
function setStatus(text) {
  state.status = text;
}

/**
 * A status a person should see. The REPL pane is the narrative surface: plain
 * lines while the page is still assembling itself, comment-style lines once
 * the prompt exists -- commentary between statements, never fake input.
 */
let statusCleared = false;
function narrate(text) {
  setStatus(text);
  if (!statusCleared) {
    statusCleared = true;
    statusEl.textContent = ""; // the pre-JS "booting..." hint has done its job
  }
  replStatus(text);
}

/** Failures keep the bottom-of-page surface: it works when the pane cannot. */
function setFatal(text) {
  setStatus(text);
  statusEl.textContent = text;
}

// --- terminal + pty ---------------------------------------------------------

// 120x34 is what the guest's output is shaped for, but that is ~940px of
// terminal: on a phone it would be a horizontal scroll of a pane. Narrower and
// shorter fits the screen instead, and the guest neither knows nor cares -- the
// wrapping is xterm's, and the bytes the drivers read are tapped before it.
const narrow = window.matchMedia("(max-width: 720px)").matches;
const xterm = new Terminal({
  cols: narrow ? 60 : 120,
  rows: narrow ? 20 : 34,
  convertEol: false,
  fontSize: narrow ? 11 : 13,
});
xterm.open(document.getElementById("terminal"));

const { master, slave } = openpty();
Module.pty = slave; // stock: exactly what the upstream demo does

const ring = createRing(1 << 20);
const qmpRing = createRing(1 << 16);
const note = createNote();
const writer = new RingWriter(ring);
const qmpWriter = new RingWriter(qmpRing);
const LOW_WATER = 64 * 1024;
let deferredAck = null;

// Rendering is batched to one xterm.write per animation frame. This matters far
// more than it looks: Emscripten proxies every filesystem syscall to the main
// thread, so QEMU's QMP monitor only gets serviced when the main thread is idle.
// Rendering each 4 KB console chunk as it arrives saturates the main thread
// during boot, and the monitor stops answering until the guest goes quiet.
let renderQueue = [];
let renderQueued = false;

function flushRender() {
  renderQueued = false;
  if (renderQueue.length === 0) return;
  const total = renderQueue.reduce((n, b) => n + b.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const b of renderQueue) {
    joined.set(b, at);
    at += b.length;
  }
  renderQueue = [];
  xterm.write(joined);
}

master.onWrite(([bytes, ack]) => {
  renderQueue.push(bytes);
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(flushRender);
  }
  consoleChunks.push(String.fromCharCode(...bytes));
  consoleCache = null;
  try {
    writer.write(bytes);
  } catch (err) {
    // the ring only overflows if labgrid stops reading entirely
    state.errors.push(String(err));
  }
  // Flow control: hold the ack until labgrid has drained enough. xterm-pty
  // stops pumping until we call it, so QEMU backpressures instead of us
  // dropping console bytes.
  if (writer.free > LOW_WATER) ack();
  else deferredAck = ack;
});


const toGuest = (data) => master.ldisc.writeFromLower(data);
xterm.onData(toGuest);
xterm.onBinary(toGuest);

// --- QEMU-WASM lifecycle ----------------------------------------------------

let qemuStarted = false;
let qmp = null;

// The guest files are independent of anything labgrid decides, so fetching them
// does not have to wait for Pyodide to finish booting. Started here, awaited in
// startQemu(); on a cold cache that overlaps a ~27 MB download with a ~15 s
// Python startup instead of running them back to back.
const guest = { mode: null, done: false, files: [], progress: null };
state.guest = guest;

async function prepareGuest() {
  if (REPLAY) {
    // Nothing to fetch: there is no QEMU to feed. This is most of why the
    // replay tier is fast -- it skips a 27 MB download and a 66 MB wasm.
    guest.mode = "replay";
    guest.done = true;
    return;
  }
  const manifest = await fetchGuestManifest(QEMU_BASE);
  guest.mode = "manifest";
  guest.files = await stageGuestFiles(Module, QEMU_BASE, manifest, (path, got, total) => {
    guest.progress = { path, got, total };
  });
  guest.progress = null;
  guest.done = true;
}

const guestReady = prepareGuest();
guestReady.catch(() => {}); // the real handling is in startQemu; this just avoids an unhandled rejection

/**
 * The replay tier's stand-in for startQemu(): same contract, no QEMU. labgrid
 * has already built its argv by the time we get here and is blocked waiting for
 * the RUNNING state, exactly as it is for the real thing.
 */
async function startReplay(argv, onQmpByte) {
  state.mode = "replay";
  state.argv = argv; // still labgrid's own, still worth asserting on
  narrate("replaying a recorded boot (no QEMU)");
  try {
    const res = await fetch(new URL(REPLAY_FIXTURE, location.href).href);
    if (!res.ok) throw new Error(`${REPLAY_FIXTURE}: HTTP ${res.status}`);
    const fixture = await res.json();
    state.fixture = { recorded: fixture.recorded, bootBytes: fixture.boot.length };

    // The console first: createFakeQmp greets immediately, and the greeting has
    // to be in the ring before labgrid is released to read it.
    const power = startFakeConsole(slave, fixture);
    qmp = createFakeQmp(onQmpByte, counters, power);
    window.__qmp = qmp;

    writer.setState(RUNNING);
    narrate(`replaying ${fixture.boot.length} recorded bytes (no QEMU)`);
  } catch (err) {
    setNote(note, String(err));
    writer.setState(STOPPED);
    qmpWriter.setState(STOPPED);
    setFatal("replay failed: " + err);
  }
}

async function startQemu(argv) {
  if (qemuStarted) return;
  qemuStarted = true;

  // Stock labgrid starts QEMU paused (it appends -S itself) and issues "cont"
  // from on(), over QMP. Both are real here; the page only has to supply the
  // chardev the monitor talks over.
  // FS_createDevice hands us one byte per call, so batching is worth it -- but it
  // must be flushed *synchronously*, never from a microtask or a timer.
  //
  // QEMU's poll never blocks in this build (Emscripten's poll is non-blocking and
  // xterm-pty only makes it sleep for the terminal), so QEMU's main loop spins:
  // measured at ~12k proxied syscalls per second even with the guest paused.
  // Every one of those runs on the browser main thread, so the JS stack rarely
  // empties and queued microtasks can be starved indefinitely. A microtask flush
  // here loses QMP replies that QEMU has already written: the bytes sit in
  // fromQemu while labgrid waits for a response that was produced minutes ago.
  //
  // QMP is line-oriented, so flushing on newline gives one ring write per
  // message with no dependency on the event loop ever running.
  let qmpPending = [];
  const onQmpByte = (byte) => {
    qmpPending.push(byte);
    if (byte !== 10) return;
    qmpWriter.write(Uint8Array.from(qmpPending), true); // quiet: see RingWriter.write
    qmpPending = [];
  };

  if (REPLAY) return startReplay(argv, onQmpByte);

  qmp = createQmpChannel(Module, "/dev/lgqmp", onQmpByte, counters);

  // History: with the unpatched upstream QEMU-WASM build, QMP went permanently
  // silent after ~10-60s of monitor idle. Root cause (found with an
  // instrumented rebuild): xterm-pty's poll wrapper ignores the caller's
  // timeout for non-TTY fd sets, so the monitor iothread busy-spun through the
  // proxied-syscall queue and intermittently wedged on a lost proxy wakeup.
  // Fixed at the source in our rebuild -- see build_qemu_wasm/patches/ and attachPolls()
  // below. Upstream's prebuilt binary still has the bug and is not fetched.

  window.__qmp = qmp;
  argv = [...argv, ...qmp.args()]; // -S comes from labgrid itself

  state.argv = argv; // recorded so tests can assert on what labgrid actually built

  // A QEMU that rejects its arguments exits moments after the module comes up.
  // Surfacing that as STOPPED wakes every blocked reader immediately instead of
  // letting them all sit out their timeouts.
  const died = (why) => {
    setNote(note, why);
    writer.setState(STOPPED);
    qmpWriter.setState(STOPPED);
    setFatal(why);
  };
  Module.onExit = (code) => died(`QEMU-WASM exited (status ${code})`);
  Module.onAbort = (what) => died(`QEMU-WASM aborted: ${what}`);

  try {
    // Usually finished long ago, next to Pyodide's own startup; only worth a
    // word when QEMU actually has to wait for it.
    if (!guest.done) {
      narrate("fetching the guest images ...");
      await guestReady;
      narrate("guest images staged");
    } else {
      await guestReady;
    }
    setStatus("starting QEMU-WASM");

    Module.arguments = argv;
    const initEmscriptenModule = (await import(QEMU_BASE + "out.js")).default;
    await initEmscriptenModule(Module);

    // Upstream's TTY poll fix: Emscripten's TTY poll has to consult the browser
    // pty's readiness, or a blocking read never wakes. Kept verbatim, plus a
    // counter so we can tell whether QEMU's main loop is still polling at all.
    const oldPoll = Module["TTY"].stream_ops.poll;
    const pty = Module["pty"];
    Module["TTY"].stream_ops.poll = function (stream, timeout) {
      counters.ttyPoll++;
      if (!pty.readable) return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
      return oldPoll.call(stream, timeout);
    };

    const qmpPolls = qmp.attachPolls(Module);
    if (!qmpPolls) state.errors.push("could not attach QMP device polls (Module.FS missing?)");

    writer.setState(RUNNING);
    setStatus("QEMU-WASM running");
  } catch (err) {
    died("QEMU-WASM failed: " + err);
  }
}

function stopQemu() {
  // Emscripten's PROXY_TO_PTHREAD runtime has no clean teardown, so this
  // detaches the bridge rather than killing QEMU. Reload the page for a cold
  // start. Real off()/cycle() arrive with the QMP channel.
  writer.setState(STOPPED);
  qmpWriter.setState(STOPPED);
  narrate("QEMU-WASM detached (reload for a cold start)");
}

// --- worker -----------------------------------------------------------------

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let nextId = 1;
const pending = new Map();

worker.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "status":
      narrate(msg.text);
      break;
    case "ready":
      state.ready = true;
      setStatus("labgrid ready");
      // the banner is the ready signal, exactly as in a real REPL; from here
      // on, status lines render as comments
      if (msg.banner) replPrint(msg.banner, "repl-py");
      replPhase = "interactive";
      replArm();
      // ?manual=1 leaves the driving to the caller (that is what the tests do)
      if (!new URLSearchParams(location.search).has("manual")) runDemo();
      break;
    case "start-qemu":
      startQemu(msg.argv);
      break;
    case "stop-qemu":
      stopQemu();
      break;
    case "tx":
      toGuest(msg.bytes);
      break;
    case "qmp-tx":
      if (qmp) qmp.send(msg.bytes);
      break;
    case "consumed":
      if (deferredAck && writer.free > LOW_WATER) {
        const ack = deferredAck;
        deferredAck = null;
        ack();
      }
      break;
    case "stdout":
    case "stderr":
      console.log("[py]", msg.line); // and the devtools log, for copy-paste
      replPrint(msg.line, msg.type === "stderr" ? "repl-err" : "repl-py");
      break;
    case "repl-stream": // per-push captured stdout/stderr, in raw chunks
      replChunk(msg.text, msg.stream === "stderr" ? "repl-err" : "repl-py");
      break;
    case "result": {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (entry) entry(msg);
      break;
    }
    case "fatal":
      state.errors.push(msg.error);
      setFatal("worker error: " + msg.error);
      break;
  }
};

/** Run Python in the worker. Returns {ok, value|error}. */
function runPython(code) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ type: "run", code, id });
  });
}
window.__run = runPython;

// --- the REPL pane ----------------------------------------------------------
// A real Python REPL beside the serial console: pyodide's PyodideConsole
// (Python's code.InteractiveConsole) running in the same worker namespace the
// demo script runs in -- what demo.py defines, the human can poke at. This
// side only renders: prompts (timestamped, like a shell prompt command),
// "..." continuation, streamed output, tab completion. Execution is real and
// synchronous in the worker; while a transition() blocks, labgrid's step log
// and the guest console keep streaming, so a long call shows its work.

const replOut = document.getElementById("repl-out");
const replIn = document.getElementById("repl-in");
const replPs = document.getElementById("repl-ps");
let replMore = false; // inside a continuation ("..." prompt)?
let replPhase = "preamble"; // flips to "interactive" when the banner prints

/**
 * A status line in the pane: plain while the page is assembling itself,
 * a comment once there is a prompt -- commentary, not fake input.
 */
function replStatus(text) {
  if (replPhase === "preamble") replPrint(text, "repl-pre");
  else replPrint(`# ${text}`, "repl-comment");
}

function replScroll() {
  replOut.parentElement.scrollTop = replOut.parentElement.scrollHeight;
}

/** A whole line (input echo, error, banner). */
function replPrint(text, cls) {
  if (!replOut) return;
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  replOut.appendChild(div);
  replScroll();
}

/** A raw stream chunk: append as-is, newlines and partial lines included. */
function replChunk(text, cls) {
  if (!replOut) return;
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  replOut.appendChild(span);
  replScroll();
}

function replArm() {
  if (!replIn) return;
  replPs.textContent = replMore ? "... " : ">>> ";
  replIn.disabled = false;
  replIn.focus();
  replScroll(); // the prompt sits at the end of the scrollback; keep it in view
}

// clicking anywhere in the pane focuses the prompt, unless selecting text
document.getElementById("repl")?.addEventListener("click", () => {
  if (!window.getSelection()?.toString() && replIn && !replIn.disabled) replIn.focus();
});

function runRepl(type, extra) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ type, id, ...extra });
  });
}

/**
 * Put a file into the worker's filesystem, and drop it from sys.modules there.
 *
 * Resolves once the worker has done it -- which, during a pytest run, is after
 * that run finishes: the worker is single-threaded and blocked, so the message
 * simply queues. Messages are handled in order, so an edit made mid-run lands
 * before whatever is sent next, which is exactly the wanted semantics.
 */
function writeFile(path, source) {
  return runRepl("write-file", { path, source });
}

// The prompt waits for an in-flight write before running a line, so that
// switching tabs and immediately typing cannot outrun the round trip.
let pendingWrite = Promise.resolve();

/** Feed one input line to the console, exactly like typing it. */
async function replPush(line) {
  await pendingWrite;
  if (replIn) replIn.disabled = true;
  const cls = line.trimStart().startsWith("#") ? "repl-comment" : "repl-in-echo";
  replPrint(`${replMore ? "... " : ">>> "}${line}`, cls);
  const res = await runRepl("repl", { code: line });
  let out = { status: "error", text: res.error };
  if (res.ok) out = JSON.parse(res.value);
  replMore = out.status === "incomplete";
  if (out.status === "error") replPrint(out.text, "repl-err");
  else if (out.status === "ok" && out.repr != null) replPrint(out.repr, "repl-py");
  replArm();
  return out;
}

async function replCompleteAt() {
  const source = replIn.value.slice(0, replIn.selectionStart ?? replIn.value.length);
  const res = await runRepl("repl-complete", { source });
  if (!res.ok) return;
  const { completions, start } = JSON.parse(res.value);
  if (!completions.length) return;
  const rest = replIn.value.slice(source.length);
  if (completions.length === 1) {
    replIn.value = source.slice(0, start) + completions[0] + rest;
  } else {
    replPrint(completions.slice(0, 24).join("  ") + (completions.length > 24 ? "  …" : ""), "repl-py");
    // fill the common prefix, like readline does
    let common = completions[0];
    for (const c of completions) while (!c.startsWith(common)) common = common.slice(0, -1);
    if (common) replIn.value = source.slice(0, start) + common + rest;
  }
}

const history = [];
let histAt = 0;
replIn?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const line = replIn.value;
    replIn.value = "";
    if (line.trim()) {
      history.push(line);
      histAt = history.length;
    }
    // An empty line matters inside a continuation (it closes the block), and
    // is a fresh prompt outside of one -- same as the real REPL.
    if (line.trim() || replMore) replPush(line);
    else {
      replPrint(">>> ", "repl-in-echo");
      replArm();
    }
  } else if (ev.key === "Tab") {
    ev.preventDefault();
    replCompleteAt();
  } else if (ev.key === "ArrowUp" && histAt > 0) {
    histAt--;
    replIn.value = history[histAt];
    ev.preventDefault();
  } else if (ev.key === "ArrowDown") {
    histAt = Math.min(histAt + 1, history.length);
    replIn.value = history[histAt] ?? "";
    ev.preventDefault();
  }
});

// Run demo.py through the REPL, line by line, exactly as if a person had
// typed it -- comments and all. Nothing is skipped or pre-warmed: the
// timestamps in the pane are the honest cost of every step.
async function runDemo() {
  setStatus("running demo.py");
  const src = await runPython(`open("/demo/demo.py").read()`);
  if (!src.ok) {
    state.results.demo = src;
    setStatus("demo failed: " + src.error);
    return;
  }
  let failed = null;
  for (const line of src.value.replace(/\n$/, "").split("\n")) {
    const out = await replPush(line);
    if (out.status === "error") { failed = out.text; break; }
  }
  state.results.demo = failed ? { ok: false, error: failed } : { ok: true };
  setStatus(failed ? "demo failed: " + failed : "demo finished");
}
window.__runDemo = runDemo;

// the env.yaml and test tabs; the prompt is the third, and stays as it was
state.editors = initEditors({
  writeFile,
  onPendingWrite: (p) => { pendingWrite = p.catch(() => {}); },
});

worker.postMessage({ type: "init", ring, qmpRing, note, qemuVersion: QEMU_VERSION });
