// A third bidirectional byte channel into QEMU-WASM, for the SSHDriver.
//
// labgrid's SSHDriver talks SSH to the guest; the browser has no TCP path into
// the guest, so SSH rides a virtio-serial port instead. This is built exactly
// like the QMP channel (qmpchannel.js): two Emscripten character devices made
// from Module.preRun back QEMU's `pipe` chardev, so no rebuild is needed and
// prebuilt QEMU-WASM artifacts stay usable. The difference from QMP is only at
// the ends: the QEMU side attaches the chardev to a virtio-serial port (the
// guest's lgssh gateway bridges that port to a dropbear), and the host side
// carries an opaque binary SSH stream rather than line-oriented JSON -- so there
// is no newline flush; bytes are batched per write burst and handed to the ring.
//
// Direction, as for QMP: QEMU reads <path>.in (host -> guest, the toQemu queue)
// and writes <path>.out (guest -> host, the fromQemu queue). char-pipe opens
// both O_RDWR, so both devices carry both callbacks (a read-only .in would fail
// to open). An input callback returning undefined is EAGAIN (nothing to read
// now); returning null would be EOF and would close the port.

export function createSshChannel(Module, path = "/dev/lgssh", onBytes = null, counters = null) {
  const nodes = {};
  const toQemu = []; // bytes QEMU will read from <path>.in  (host -> guest)
  const fromQemu = []; // bytes QEMU has written to <path>.out (guest -> host)

  Module.preRun = Module.preRun || [];
  Module.preRun.push(() => {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const base = path.slice(path.lastIndexOf("/") + 1);

    nodes.in = Module.FS_createDevice(
      dir,
      base + ".in",
      () => {
        if (counters) counters.sshInCall++;
        if (toQemu.length === 0) return undefined; // EAGAIN
        if (counters) counters.sshInBytes++;
        return toQemu.shift();
      },
      () => {}, // never written to; present only so the device opens O_RDWR
    );
    nodes.out = Module.FS_createDevice(
      dir,
      base + ".out",
      () => undefined, // never read from
      (byte) => {
        if (byte === null) return; // flush marker on close
        fromQemu.push(byte);
        if (counters) counters.sshOutBytes++;
        if (onBytes) onBytes(byte);
      },
    );
  });

  return {
    /**
     * Honest poll semantics, exactly as the QMP channel needs them: without a
     * stream_ops.poll Emscripten reports the device always readable/writable,
     * so QEMU's virtio-serial loop busy-spins on EAGAIN reads. Call after the
     * module is initialized (FS.registerDevice has run in preRun, and open
     * streams share the stream_ops object, so patching it reaches QEMU's
     * already-open fds).
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
    /** Queue bytes (an array of byte values, or a Uint8Array) for QEMU to read. */
    send: (data) => {
      for (const b of data) toQemu.push(b);
    },
    /** The QEMU arguments attaching this channel to a named virtio-serial port.
     * The guest sees it as /dev/vportNpM named "lgssh"; the lgssh gateway finds
     * it by that name. This is injected by the page (main.js), never in
     * env.yaml -- exactly as the QMP chardev is -- so env.yaml stays identical
     * to a real board's. */
    args: () => [
      "-device", "virtio-serial-device",
      "-chardev", `pipe,id=lgssh,path=${path}`,
      "-device", "virtserialport,chardev=lgssh,name=lgssh",
    ],
  };
}
