// A scripted stand-in for QEMU, for the fast test tier.
//
// Booting the real guest takes two and a half minutes and varies by a lot, so
// everything between labgrid and QEMU -- the SharedArrayBuffer rings, _read's
// timeout, the byte marshalling across the Pyodide boundary, QMPMonitor's line
// buffering -- can only be regression-tested at that price. This replaces the
// *guest*, and nothing else: the fake sits on the xterm-pty slave, exactly where
// QEMU's Emscripten TTY sits, so the console tap, the ring and the whole labgrid
// stack above them are the production ones.
//
// Be clear about what that does and does not prove. It exercises labgrid's
// login state machine, its marker protocol, pexpect's regex machinery, VT100
// stripping, exit-code parsing, and every line of our bridge. It proves nothing
// about QEMU-WASM -- not the argv, not the guest-file staging, not the poll
// patch. That is what m4 and m5 are for, and this does not replace them.
//
// One gap worth naming rather than glossing: this guest's recorded boot log is
// under 5 KB, so it never reaches the 64 KB low-water mark where main.js starts
// deferring the flow-control ack. The backpressure path is real code that this
// tier does not reach.
//
// The boot log is recorded from a real run by tests/record-fixture.mjs, so the
// bytes flowing through the ring are real bytes in realistic chunks. What the
// shell says back is synthetic, because it has to be: labgrid puts a fresh
// random marker in every command (util/marker.py), so no recording of a shell
// session can ever be replayed verbatim.

const enc = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// --- QMP --------------------------------------------------------------------

/**
 * Answers QMP the way QEMU does, with the same shape as createQmpChannel() so
 * the page and the failure dumps do not have to know the difference.
 *
 * `power` is shared with the console side: labgrid's on() is a "cont", and a
 * guest that is not running must stay silent -- that is a real assertion in the
 * suite, so the fake has to honour it.
 */
export function createFakeQmp(onByte, counters, power) {
  const fromQemu = [];
  const decoder = new TextDecoder();

  const emit = (obj) => {
    for (const byte of enc(JSON.stringify(obj) + "\r\n")) {
      fromQemu.push(byte);
      if (counters) counters.qmpOutBytes++;
      onByte(byte);
    }
  };

  // QEMU greets as soon as the monitor is connected, before anything is asked
  emit({ QMP: { version: { qemu: { major: 8, minor: 2, micro: 0 }, package: "" }, capabilities: [] } });

  const execute = ({ execute: cmd, arguments: args = {} }) => {
    switch (cmd) {
      case "qmp_capabilities":
        return {};
      case "query-status":
        return {
          status: power.running ? "running" : power.started ? "paused" : "prelaunch",
          singlestep: false,
          running: power.running,
        };
      case "cont":
        power.cont();
        return {};
      case "stop":
        power.stop();
        return {};
      case "system_reset":
        power.reset();
        return {};
      case "human-monitor-command":
        return `VM status: ${power.running ? "running" : "paused"}\r\n`;
      default:
        return {};
    }
  };

  let line = "";
  return {
    path: "(replay)",
    nodes: {},
    attachPolls: () => true,
    toQemu: [],
    fromQemu,
    text: () => decoder.decode(new Uint8Array(fromQemu)),
    args: () => [], // no chardev to attach; labgrid's argv is still recorded
    send: (data) => {
      const text = typeof data === "string" ? data : String.fromCharCode(...data);
      for (const ch of text) {
        if (ch !== "\n") {
          line += ch;
          continue;
        }
        const request = line.trim();
        line = "";
        if (!request) continue;
        try {
          emit({ return: execute(JSON.parse(request)) });
        } catch (err) {
          emit({ error: { class: "GenericError", desc: String(err) } });
        }
      }
    },
  };
}

// --- the console ------------------------------------------------------------

// labgrid's ShellDriver drives a POSIX shell through a very small protocol
// (driver/shelldriver.py): it defines a `run` function, then sends
// `MARKER='xxxx''yyyyyy' run '<cmd>'` and reads back
// `<marker><stdout><marker> <exit>` followed by the prompt. The marker is split
// in the command so the echo of the command line cannot match. Everything below
// is the guest half of that protocol.
const RUN_CMD = /^MARKER='(\S{4})''(\S{6})'\s+run\s+(.*)$/;
const ECHO_MARKER = /^echo\s+'(\S{4})''(\S{6})'$/;
const RUN_DEF = /^run\(\)\s*\{/;

/** Undo the shlex.quote() labgrid applies to the command. */
function unquote(arg) {
  const trimmed = arg.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'"'"'/g, "'");
  }
  return trimmed;
}

/** The tiny bit of shell the protocol actually needs. Returns [stdout, exit]. */
function sh(cmd, fixture) {
  if (cmd === "false") return ["", 1];
  if (cmd === "true") return ["", 0];
  if (cmd === "uname -a") return [fixture.uname + "\r\n", 0];
  if (cmd.startsWith("echo ")) {
    const rest = cmd.slice(5);
    const noNewline = rest.startsWith("-n ");
    const body = unquote(noNewline ? rest.slice(3) : rest);
    return [noNewline ? body : body + "\r\n", 0];
  }
  // Unknown commands succeed silently rather than failing, so that a future
  // labgrid adding an internal command does not break this with a confusing
  // exit code. Assertions about real command output belong in m4.
  return ["", 0];
}

/**
 * Play a recorded boot log into the pty and then answer as a shell.
 *
 * Returns the power hooks the QMP side calls, so that cont/stop/system_reset
 * really start, silence and restart the guest.
 */
export function startFakeConsole(slave, fixture) {
  const boot = enc(fixture.boot);
  const CHUNK = 4096;

  let queue = [];
  let bootAt = 0;
  let booting = false;
  let loggedIn = false;

  const say = (text) => queue.push(...enc(text));
  const prompt = () => say("\r\n" + fixture.prompt);

  // Write only while xterm-pty will take it: the master side holds back its ack
  // until labgrid has drained the ring, and a guest that ignores that would be
  // a guest QEMU is not. (This log is too small to actually trigger it -- see
  // the gap noted at the top.)
  function pump() {
    while (queue.length && slave.writable) {
      slave.write(queue.splice(0, CHUNK));
    }
    if (booting && !queue.length && slave.writable) {
      if (bootAt < boot.length) {
        queue.push(...boot.slice(bootAt, bootAt + CHUNK));
        bootAt += CHUNK;
        setTimeout(pump, 0); // yield, so the reader gets a turn
      } else {
        booting = false;
      }
    }
  }
  slave.onWritable(pump);

  // A byte stream, not a line stream: a write can split a line anywhere, so
  // hold the remainder rather than treating the tail of a chunk as a line.
  let input = "";
  slave.onReadable(() => {
    const data = slave.read();
    if (!data || !data.length) return;
    input += String.fromCharCode(...data);
    for (let nl = input.indexOf("\n"); nl >= 0; nl = input.indexOf("\n")) {
      const line = input.slice(0, nl).replace(/\r$/, "");
      input = input.slice(nl + 1);
      handle(line);
    }
    pump();
  });

  function handle(line) {
    if (!loggedIn) {
      // Enter at the console-ready banner brings up the login prompt; the
      // username brings up the shell. That is the whole of what ShellDriver's
      // _await_login() state machine needs to see.
      if (line.trim() === fixture.username) {
        loggedIn = true;
        say("\r\n");
        prompt();
      } else {
        say("\r\n" + fixture.loginPrompt);
      }
      return;
    }

    say(line + "\r\n"); // terminal echo, as a real tty does

    const run = RUN_CMD.exec(line);
    if (run) {
      const marker = run[1] + run[2];
      const [stdout, exit] = sh(unquote(run[3]), fixture);
      say(`${marker}${stdout}${marker} ${exit}\r\n`);
      say(fixture.prompt);
      return;
    }

    const echo = ECHO_MARKER.exec(line);
    if (echo) {
      // _check_prompt: echo the two halves joined, then the prompt
      say(`${echo[1]}${echo[2]}\r\n${fixture.prompt}`);
      return;
    }

    if (RUN_DEF.test(line)) {
      say(fixture.prompt); // shell function definition produces no output
      return;
    }

    if (!line.trim()) {
      say(fixture.prompt);
      return;
    }

    const [stdout] = sh(line, fixture);
    say(stdout + fixture.prompt);
  }

  return {
    started: false,
    running: false,
    cont() {
      this.started = this.running = true;
      if (bootAt === 0) booting = true;
      pump();
    },
    stop() {
      this.running = false;
      booting = false;
      queue = [];
    },
    reset() {
      bootAt = 0;
      loggedIn = false;
      queue = [];
      input = "";
      booting = this.running;
      pump();
    },
  };
}
