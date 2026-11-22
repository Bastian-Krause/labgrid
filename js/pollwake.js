// Waking QEMU's threads out of poll(), for the page's Emscripten devices.
//
// A poll() proxied from a pthread blocks on a wait-queue Emscripten keeps per
// inode (since 6.0.3): the runtime asks each fd's stream_ops.poll(stream) for
// its readiness mask and, if nothing is ready, registers a listener on every
// node and parks the calling thread until one of them is notified or the
// timeout runs out. Producers announce transitions with
// node.notifyListeners(flags). Emscripten's own sockets and pipes do -- so the
// virtio-net backend wakes QEMU's main loop by itself -- and the page's
// devices do the same here: when bytes are queued for QEMU to read, or when
// the console ring has room again. A device that never notifies is one QEMU's
// QMP iothread sleeps on forever (its g_poll has no timeout when idle); one
// that always reports ready is a busy loop.
//
// A listener re-reads the masks there and then (stream_ops.poll, nothing
// else) and resolves the sleeper's promise if one is ready, so notify after
// the state poll() reads has changed; from inside a syscall or an event
// handler is fine.

export const POLLIN = 1;
export const POLLOUT = 4;

/** The device node became ready for `flags` (POLLIN / POLLOUT): wake sleepers. */
export function wake(node, flags) {
  node?.notifyListeners?.(flags);
}
