// The serial console as a `pipe` chardev instead of Emscripten's TTY.
//
// With labgrid's default `-nographic`, QEMU puts the serial port on stdio, i.e.
// on xterm-pty's TTY (fds 0-2). That TTY is the one fd set whose poll returns
// immediately by design (see build_qemu_wasm/patches/xterm-pty: the blocking
// emulation is applied only to fd sets that do NOT include the TTY, because
// making the TTY poll sleep broke Asyncify timing). So QEMU's main loop spins:
// every iteration is a proxied poll syscall on the browser main thread --
// measured at 12-16k/s, ~1.2 cores burned with the guest idle at a prompt.
//
// Put the serial port on a pipe chardev instead, exactly as the QMP monitor and
// the SSH virtio-serial port already are (qmpchannel.js, sshchannel.js), and
// name the monitor explicitly too: with both `-serial` and `-qmp` given,
// `-nographic` attaches nothing to stdio, the TTY drops out of the main loop's
// poll set, and the patched poll wrapper's blocking emulation applies -- the
// loop naps in 4 ms slices until a fd is ready.
//
// Unlike the QMP/SSH channels this one is not built with FS_createDevice: its
// byte-at-a-time callbacks cannot report EAGAIN or a short write (any throw
// becomes EIO), and the console needs real backpressure -- xterm-pty gave it by
// holding the ack until labgrid had drained the ring, and QEMU (the pl011's TX
// FIFO, then the guest) stalled behind it. So this registers a device with its
// own stream_ops (Module.FS is exported in this build): read() throws EAGAIN
// when there is nothing typed, write() takes at most what the ring can hold and
// throws EAGAIN at zero, and poll() reports POLLIN/POLLOUT truthfully. QEMU's fd
// chardev handles EAGAIN by waiting for POLLOUT, which is the same stall.
//
// Direction as for the others: QEMU reads <path>.in (host -> guest: typed keys,
// labgrid's tx) and writes <path>.out (guest -> host: the console). char-pipe
// opens both O_RDWR, so both devices carry both ops.

const EAGAIN = 6; // Emscripten's errno value

export function createConsoleChannel(Module, path = "/dev/lgcon", { onBytes, canAccept, counters } = {}) {
  const toQemu = []; // host -> guest, drained from the front
  let head = 0;

  Module.preRun = Module.preRun || [];
  Module.preRun.push((mod) => {
    const FS = (mod && mod.FS) || Module.FS;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const base = path.slice(path.lastIndexOf("/") + 1);
    // FS_createDevice numbers its majors from 64; stay clear of it.
    const inDev = FS.makedev(200, 0);
    const outDev = FS.makedev(200, 1);

    FS.registerDevice(inDev, {
      open(stream) { stream.seekable = false; },
      close() {},
      read(stream, buffer, offset, length) {
        if (counters) counters.conInCall++;
        const avail = toQemu.length - head;
        if (avail === 0) throw new FS.ErrnoError(EAGAIN);
        const n = Math.min(avail, length);
        for (let i = 0; i < n; i++) buffer[offset + i] = toQemu[head + i];
        head += n;
        if (head === toQemu.length) { toQemu.length = 0; head = 0; }
        if (counters) counters.conInBytes += n;
        return n;
      },
      write(stream, buffer, offset, length) { return length; }, // never written; O_RDWR open only
      poll() { return toQemu.length - head ? 1 /* POLLIN */ : 0; },
    });

    FS.registerDevice(outDev, {
      open(stream) { stream.seekable = false; },
      close() {},
      read() { throw new FS.ErrnoError(EAGAIN); }, // never read
      write(stream, buffer, offset, length) {
        const room = canAccept ? canAccept() : length;
        if (room <= 0) throw new FS.ErrnoError(EAGAIN); // backpressure: QEMU waits for POLLOUT
        const n = Math.min(length, room);
        // buffer is a signed view of the shared wasm heap: take an unsigned copy
        // before the memory is reused.
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n).slice();
        if (counters) counters.conOutBytes += n;
        onBytes(bytes);
        return n;
      },
      poll() { return (canAccept ? canAccept() : 1) > 0 ? 4 /* POLLOUT */ : 0; },
    });

    FS.mkdev(`${dir}/${base}.in`, 0o666, inDev);
    FS.mkdev(`${dir}/${base}.out`, 0o666, outDev);
  });

  const encoder = new TextEncoder();
  return {
    /** Queue bytes (Uint8Array / array of byte values) or a string (UTF-8) for the guest. */
    send: (data) => {
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      for (const b of bytes) toQemu.push(b);
    },
    pending: () => toQemu.length - head,
    /** The QEMU arguments attaching the serial console to this channel. */
    args: () => ["-chardev", `pipe,id=con,path=${path}`, "-serial", "chardev:con"],
  };
}
