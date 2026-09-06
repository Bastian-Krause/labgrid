// A second bidirectional byte channel into QEMU-WASM, for QMP.
//
// labgrid's stock on()/off()/cycle()/monitor_command() all go through QMP, and
// QEMU only gets one ready-made stream in the browser: the Emscripten TTY, which
// the serial console already owns. Emscripten has no AF_UNIX and no usable
// sockets without a relay, so the second channel is built out of two custom
// Emscripten character devices created from Module.preRun -- which needs no
// rebuild, so prebuilt upstream QEMU-WASM artifacts stay usable.
//
// QEMU's `pipe` chardev opens <path>.in for reading and <path>.out for writing,
// with no termios involved, which makes it the natural fit for a pair of plain
// character devices.
//
// Two details the upstream build forces on us:
//
//   * Module.FS is not exported, only the FS_* helpers are. FS_createDevice is
//     enough: its (input, output) callbacks are byte-at-a-time, which is fine
//     for a line-oriented JSON monitor.
//   * char-pipe opens both ends O_RDWR, so both devices must be created with
//     *both* callbacks -- FS_createDevice derives the file mode from which
//     callbacks are present, and a read-only .in would fail to open.
//
// An input callback returning undefined becomes EAGAIN, which is exactly what a
// non-blocking pipe with nothing in it should do. Returning null would mean EOF,
// and QEMU would treat the monitor as closed.

export function createQmpChannel(Module, path = "/dev/lgqmp", onByte = null, counters = null) {
  const nodes = {};
  const toQemu = []; // bytes QEMU will read from <path>.in
  const fromQemu = []; // bytes QEMU has written to <path>.out

  Module.preRun = Module.preRun || [];
  Module.preRun.push(() => {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const base = path.slice(path.lastIndexOf("/") + 1);

    nodes.in = Module.FS_createDevice(
      dir,
      base + ".in",
      () => {
        if (counters) counters.qmpInCall++;
        if (toQemu.length === 0) return undefined;
        if (counters) counters.qmpInBytes++;
        return toQemu.shift();
      },
      () => {}, // never written to; present only so the device is opened O_RDWR
    );
    nodes.out = Module.FS_createDevice(
      dir,
      base + ".out",
      () => undefined, // never read from
      (byte) => {
        if (byte === null) return; // flush marker on close
        fromQemu.push(byte);
        if (counters) counters.qmpOutBytes++;
        if (onByte) onByte(byte);
      },
    );
  });

  const decoder = new TextDecoder();
  return {
    path,
    nodes,

    /**
     * Give the two devices honest poll semantics. Emscripten's default for a
     * device without stream_ops.poll is DEFAULT_POLLMASK -- always readable and
     * writable -- which makes the QMP iothread's g_poll return instantly forever
     * and busy-spin dispatching reads that yield EAGAIN. Combined with the
     * patched poll wrapper (see build_qemu_wasm/patches/), an idle monitor now sleeps.
     *
     * Call after the module is initialized: FS.registerDevice has run by then
     * (preRun), and open streams share the same stream_ops object, so patching
     * it retroactively affects QEMU's already-open pipe fds.
     */
    attachPolls: (Module) => {
      const FS = Module.FS;
      if (!FS || !FS.devices || !nodes.in || !nodes.out) return false;
      const devIn = FS.devices[nodes.in.rdev];
      const devOut = FS.devices[nodes.out.rdev];
      if (!devIn || !devOut) return false;
      devIn.stream_ops.poll = () => (toQemu.length ? 1 /* POLLIN */ : 0);
      devOut.stream_ops.poll = () => 4 /* POLLOUT */;
      return true;
    },
    toQemu,
    fromQemu,
    /** Everything QEMU has written so far, as text. */
    text: () => decoder.decode(new Uint8Array(fromQemu)),
    /** Queue bytes (a string, or an array of byte values) for QEMU to read. */
    send: (data) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      for (const b of bytes) toQemu.push(b);
    },
    /** The QEMU arguments that attach this channel to the QMP monitor. */
    args: () => ["-chardev", `pipe,id=qmp,path=${path}`, "-qmp", "chardev:qmp"],
  };
}
