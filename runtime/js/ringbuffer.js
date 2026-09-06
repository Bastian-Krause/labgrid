// A single-producer / single-consumer byte ring in a SharedArrayBuffer.
//
// The main thread writes QEMU's console output; the Pyodide worker reads it and
// is allowed to *block*, because labgrid's console stack is synchronous all the
// way down (expect -> pexpect -> QEMUDriver._read). Atomics.wait is what makes
// that legal: it parks the worker without touching the main thread, where
// Atomics.wait throws by specification and blocking would starve the Emscripten
// proxy queue QEMU-WASM's pthreads depend on.
//
// The reverse direction (labgrid -> QEMU) needs no ring: the worker just posts a
// message, because nothing on that path has to block.

export const SEQ = 0; // bumped + notified on *any* change, so one wait covers all events
export const WRITE = 1; // total bytes ever written  (main thread owns)
export const READ = 2; // total bytes ever consumed  (worker owns)
export const STATE = 3; // see below
export const CTL_LEN = 4;

export const IDLE = 0;
export const RUNNING = 1;
export const STOPPED = 2;

export function createRing(capacity = 1 << 20) {
  if ((capacity & (capacity - 1)) !== 0) throw new Error("capacity must be a power of two");
  return {
    ctl: new SharedArrayBuffer(CTL_LEN * 4),
    data: new SharedArrayBuffer(capacity),
  };
}

export class RingWriter {
  constructor({ ctl, data }) {
    this.ctl = new Int32Array(ctl);
    this.data = new Uint8Array(data);
    this.cap = this.data.length;
  }

  get free() {
    return this.cap - (Atomics.load(this.ctl, WRITE) - Atomics.load(this.ctl, READ));
  }

  /**
   * Write bytes. Returns free space afterwards so the caller can gate flow control.
   * `quiet` skips the Atomics.notify: use it from inside an Emscripten proxied
   * syscall callback, where notifying interferes with Emscripten's own proxy
   * handshake (the calling pthread is parked on it) and shows up as random wasm
   * traps. A quiet write is still seen, because RingReader.read polls in slices.
   */
  write(bytes, quiet = false) {
    const n = bytes.length;
    if (n > this.free) {
      // Dropping console bytes would show up as a mysterious expect() failure
      // much later, so refuse loudly instead.
      throw new Error(`console ring overflow: ${n} bytes, ${this.free} free`);
    }
    // Bulk copy, not a byte loop. Every console byte crosses this method on the
    // main thread, and the main thread is where Emscripten services QEMU's
    // proxied syscalls -- including the QMP monitor's. A per-byte loop with a
    // modulo over a 4 KB chunk is exactly the kind of main-thread work that
    // makes the monitor stop answering during boot.
    const src = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const w = Atomics.load(this.ctl, WRITE);
    const start = w % this.cap;
    const first = Math.min(n, this.cap - start);
    this.data.set(src.subarray(0, first), start);
    if (first < n) this.data.set(src.subarray(first), 0);
    Atomics.store(this.ctl, WRITE, w + n);
    if (!quiet) this.bump();
    return this.free;
  }

  setState(state) {
    Atomics.store(this.ctl, STATE, state);
    this.bump();
  }

  bump() {
    Atomics.add(this.ctl, SEQ, 1);
    Atomics.notify(this.ctl, SEQ);
  }
}

export class RingReader {
  constructor({ ctl, data }) {
    this.ctl = new Int32Array(ctl);
    this.data = new Uint8Array(data);
    this.cap = this.data.length;
  }

  get available() {
    return Atomics.load(this.ctl, WRITE) - Atomics.load(this.ctl, READ);
  }

  get state() {
    return Atomics.load(this.ctl, STATE);
  }

  /**
   * Block for up to timeoutMs for at least one byte.
   * Returns a Uint8Array, or null on timeout. Never returns an empty array.
   */
  read(maxBytes, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const avail = this.available;
      if (avail > 0) return this.take(Math.min(avail, maxBytes));

      // Sample SEQ *before* re-checking, so a write that lands in between makes
      // the wait return immediately instead of being lost.
      const seq = Atomics.load(this.ctl, SEQ);
      if (this.available > 0) continue;
      if (this.state === STOPPED) return null;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // Wait in slices rather than for the whole remaining time: a writer inside
      // a proxied syscall cannot safely notify, so we must re-check by polling.
      // 25ms costs nothing and bounds the latency of a quiet write.
      Atomics.wait(this.ctl, SEQ, seq, Math.min(remaining, 25));
    }
  }

  take(n) {
    const r = Atomics.load(this.ctl, READ);
    const start = r % this.cap;
    const first = Math.min(n, this.cap - start);
    const out = new Uint8Array(n);
    out.set(this.data.subarray(start, start + first), 0);
    if (first < n) out.set(this.data.subarray(0, n - first), first);
    Atomics.store(this.ctl, READ, r + n);
    return out;
  }
}

// A tiny side-channel for a human-readable note (an error message, usually).
// The worker is often parked in Atomics.wait and cannot process postMessage,
// so anything it must be able to read while blocked has to live in shared
// memory too.

export function createNote(size = 4096) {
  return new SharedArrayBuffer(4 + size);
}

export function setNote(sab, text) {
  const head = new Int32Array(sab, 0, 1);
  const body = new Uint8Array(sab, 4);
  const bytes = new TextEncoder().encode(text).subarray(0, body.length);
  body.set(bytes);
  Atomics.store(head, 0, bytes.length);
}

export function getNote(sab) {
  const head = new Int32Array(sab, 0, 1);
  const n = Atomics.load(head, 0);
  // .slice() copies out of shared memory: TextDecoder refuses a view backed by
  // a SharedArrayBuffer, and the failure would otherwise replace the error
  // message we are trying to read with a confusing one of its own.
  return n ? new TextDecoder().decode(new Uint8Array(sab, 4, n).slice()) : "";
}
