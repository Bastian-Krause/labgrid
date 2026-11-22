// The serial console as a `pipe` chardev, on a pair of Emscripten devices of
// the page's own -- exactly as the QMP monitor and the SSH virtio-serial port
// are (qmpchannel.js, sshchannel.js). With `-serial` and `-qmp` both named,
// labgrid's `-nographic` attaches nothing to QEMU's stdio, so the serial port
// never touches the TTY; QEMU's own messages go to Module.print instead.
//
// Unlike the QMP/SSH channels this one is not built with FS_createDevice: its
// byte-at-a-time callbacks cannot report EAGAIN or a short write (any throw
// becomes EIO), and the console needs real backpressure. So this registers a
// device with its own stream_ops (Module.FS is exported in this build): read()
// throws EAGAIN when there is nothing typed, write() takes at most what the ring
// can hold and throws EAGAIN at zero, and poll() reports POLLIN/POLLOUT
// truthfully. QEMU's fd chardev handles EAGAIN by waiting for POLLOUT, which
// stalls the pl011's TX FIFO and then the guest -- until labgrid has drained
// the ring and notifyRoom() wakes that wait (see pollwake.js).
//
// Direction as for the others: QEMU reads <path>.in (host -> guest: typed keys,
// labgrid's tx) and writes <path>.out (guest -> host: the console). char-pipe
// opens both O_RDWR, so both devices carry both ops.

import { wake, POLLIN, POLLOUT } from "./pollwake.js";

const EAGAIN = 6; // Emscripten's errno value

export function createConsoleChannel(Module, path = "/dev/lgcon", { onBytes, canAccept, counters } = {}) {
  const toQemu = []; // host -> guest, drained from the front
  let head = 0;
  const nodes = {}; // the two device inodes, whose wait-queues the wakes go to

  const room = () => (canAccept ? canAccept() : 1);

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
      poll() {
        if (counters) counters.conPoll++;
        return toQemu.length - head ? POLLIN : 0;
      },
    });

    FS.registerDevice(outDev, {
      open(stream) { stream.seekable = false; },
      close() {},
      read() { throw new FS.ErrnoError(EAGAIN); }, // never read
      write(stream, buffer, offset, length) {
        const r = room();
        if (r <= 0) throw new FS.ErrnoError(EAGAIN); // backpressure: QEMU waits for POLLOUT
        const n = Math.min(length, r);
        // buffer is a signed view of the shared wasm heap: take an unsigned copy
        // before the memory is reused.
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n).slice();
        if (counters) counters.conOutBytes += n;
        onBytes(bytes);
        return n;
      },
      poll() {
        return room() > 0 ? POLLOUT : 0;
      },
    });

    nodes.in = FS.mkdev(`${dir}/${base}.in`, 0o666, inDev);
    nodes.out = FS.mkdev(`${dir}/${base}.out`, 0o666, outDev);
  });

  const encoder = new TextEncoder();
  return {
    /** Queue bytes (Uint8Array / array of byte values) or a string (UTF-8) for the guest. */
    send: (data) => {
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      for (const b of bytes) toQemu.push(b);
      if (bytes.length) wake(nodes.in, POLLIN);
    },
    /** labgrid drained the ring: a write stalled on backpressure may proceed. */
    notifyRoom: () => { if (room() > 0) wake(nodes.out, POLLOUT); },
    pending: () => toQemu.length - head,
    /** The QEMU arguments attaching the serial console to this channel. */
    args: () => ["-chardev", `pipe,id=con,path=${path}`, "-serial", "chardev:con"],
  };
}
