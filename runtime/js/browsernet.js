// In-browser networking for the guest, exactly the way ktock's qemu-wasm
// networking example does it -- nothing here reimplements the stack.
//
// QEMU's socket netdev is routed over emscripten's WebSocket (Module.websocket).
// ktock's stack.js (webpack bundle of msw + a SharedArrayBuffer bridge) catches
// that WebSocket in the main thread and forwards frames to stack-worker.js,
// which runs c2w-net-proxy.wasm -- a gvisor-tap-vsock TCP/IP stack that does the
// guest's outbound HTTP(S) through the browser's Fetch API and MITMs TLS with
// its own CA. That CA comes back through the ready callback; we drop it into the
// guest over the wasm0 virtfs mount (see demo/env.yaml).
//
// MSW's WebSocket interception is a main-thread Proxy on globalThis.WebSocket,
// so it coexists with coi-serviceworker (which stays the page's COOP/COEP
// service worker for SharedArrayBuffer).

const STACK_ADDR = "http://localhost:9999/"; // ktock's address; only the page sees it

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

/**
 * Start the stack and resolve once its MITM CA has been staged into Module's
 * filesystem at /.wasmenv/proxy.crt (mounted into the guest as wasm0). Must be
 * called before the QEMU module is initialised.
 */
export async function startBrowserNet(Module) {
  // Resolve the vendored stack next to this module (runtime/js/), so it works
  // whatever base path the site is served under (e.g. gh-pages /labgrid/).
  const net = (f) => new URL("../../vendor/net/" + f, import.meta.url).href;
  await loadScript(net("stack.js")); // defines window.Stack
  Module.websocket = { url: STACK_ADDR };
  Module.preRun = Module.preRun || [];
  await new Promise((resolve) => {
    window.Stack.Start(
      STACK_ADDR,
      net("stack-worker.js"),
      net("c2w-net-proxy.wasm.gzip"),
      (cert) => {
        Module.preRun.push((mod) => {
          try { mod.FS.mkdir("/.wasmenv"); } catch (e) { /* may exist */ }
          mod.FS.writeFile("/.wasmenv/proxy.crt", cert);
        });
        resolve();
      },
    );
  });
}
