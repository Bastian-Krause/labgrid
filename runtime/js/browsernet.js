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

// --- staging: serve HTTPProviderDriver.stage()'d files back to the guest -----
//
// labgrid's HTTPProvider stages a file into an HTTP docroot and hands back a
// URL. Here the "docroot" is this in-memory store and the "HTTP server" is an
// msw request handler: HTTPProviderDriver.stage() (faked in labgrid_wasm.py)
// posts the bytes here, and when the guest fetches
// https://192.168.127.1/__staged__/<name> -- the stack's gateway IP, over the
// in-browser proxy -- msw answers from the store. Nothing leaves the browser,
// and Range requests are honoured, which is what RAUC's streaming install needs.
//
// The store and the handler both live on the main thread: msw runs a handler on
// the client that registered the worker (here), not inside the service worker,
// so a plain Map is all the state this needs.
const staged = new Map(); // basename -> Uint8Array
const stagedWaiters = new Map(); // basename -> [resolve, ...]

/** Record staged bytes. Called from main.js when the worker relays a stage(). */
export function stageBytes(name, bytes) {
  const buf = bytes.slice ? bytes.slice() : new Uint8Array(bytes);
  staged.set(name, buf);
  const waiters = stagedWaiters.get(name);
  if (waiters) {
    stagedWaiters.delete(name);
    waiters.forEach((resolve) => resolve(buf));
  }
}

/** The staged bytes for a name, waiting if stage() has not landed yet -- so the
 * guest's fetch is answered deterministically however the two race. */
function awaitStaged(name) {
  const have = staged.get(name);
  if (have) return Promise.resolve(have);
  return new Promise((resolve) => {
    const waiters = stagedWaiters.get(name) || [];
    waiters.push(resolve);
    stagedWaiters.set(name, waiters);
  });
}

/** Register the /__staged__/ handler on ktock's msw worker (exposed by our
 * one patch to stack.js). GET streams the bytes and honours Range/206; HEAD
 * reports the size, which is how a streaming client discovers it. */
function registerStaging({ worker, http, HttpResponse }) {
  const meta = (total) => ({
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(total),
  });
  worker.use(
    http.all(/\/__staged__\//, async ({ request }) => {
      const name = new URL(request.url).pathname.split("/").pop();
      const body = await awaitStaged(name);
      const total = body.byteLength;
      if (request.method === "HEAD") {
        return new HttpResponse(null, { status: 200, headers: meta(total) });
      }
      const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("Range") || "").trim());
      if (m && !(m[1] === "" && m[2] === "")) {
        let start, end;
        if (m[1] === "") {
          start = Math.max(0, total - Number(m[2]));
          end = total - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
        }
        if (start > end || start >= total) {
          return new HttpResponse(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          });
        }
        const slice = body.subarray(start, end + 1);
        return new HttpResponse(slice, {
          status: 206,
          headers: { ...meta(slice.byteLength), "Content-Range": `bytes ${start}-${end}/${total}` },
        });
      }
      return new HttpResponse(body, { status: 200, headers: meta(total) });
    }),
  );
}

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
  // stack.js has run worker.start() by now and exposed the msw worker; hook the
  // staged-file handler onto it (a no-op if the patch is somehow absent).
  if (globalThis.__labgridNet) registerStaging(globalThis.__labgridNet);
}
