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
// URL. Here the "docroot" is this in-memory store: HTTPProviderDriver.stage()
// (faked in labgrid_wasm.py) posts the bytes here, and when the guest fetches
// https://192.168.127.1/<name> -- the stack's gateway IP, over the in-browser
// proxy -- we answer from the store. Nothing else is served from that IP over
// HTTP, so matching the host is enough and the path is just the file name, as a
// real HTTP server would have it. Nothing leaves the browser, and Range requests
// are honoured, which is what RAUC's streaming install needs.
//
// The interception is at the *fetch call site* in stack.js (our one patch),
// not a service-worker handler: on GitHub Pages coi-serviceworker -- not msw --
// controls the page's fetches (it has to, to inject COOP/COEP), so an msw
// handler would never fire there. Short-circuiting before fetch() works
// whichever service worker is in charge. It all runs on the main thread, where
// stack.js issues the guest's fetches, so a plain Map is all the state we need.
const STAGE_HOST = "192.168.127.1"; // must match demo/env.yaml's HTTPProvider external
const staged = new Map(); // basename -> Uint8Array

/** Record staged bytes. Called from main.js when the worker relays a stage().
 * stage() always runs well before the guest fetches, so a plain set suffices. */
export function stageBytes(name, bytes) {
  staged.set(name, bytes.slice ? bytes.slice() : new Uint8Array(bytes));
}

/** Case-insensitive lookup in stack.js's plain request-headers object. */
function header(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

/** Build the response stack.js will hand back to the guest: the whole file, a
 * Range slice (206), or -- for HEAD -- just the size a streaming client asks
 * for first. A real Response, so stack.js reads .ok/.status/.headers/
 * .arrayBuffer() from it exactly as from fetch(). */
function stagedResponse(body, request) {
  const total = body.byteLength;
  const meta = (len) => ({
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(len),
  });
  if (request && request.method === "HEAD") {
    return new Response(null, { status: 200, statusText: "OK", headers: meta(total) });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec((header(request && request.headers, "Range") || "").trim());
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
      return new Response(null, {
        status: 416, statusText: "Range Not Satisfiable",
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const slice = body.subarray(start, end + 1);
    return new Response(slice, {
      status: 206, statusText: "Partial Content",
      headers: { ...meta(slice.byteLength), "Content-Range": `bytes ${start}-${end}/${total}` },
    });
  }
  return new Response(body, { status: 200, statusText: "OK", headers: meta(total) });
}

// Consulted by our stack.js patch before every guest fetch: a Promise<Response>
// for a file staged on the stack's gateway host, or undefined so the normal
// network fetch runs (any other host, or a name we have not staged).
globalThis.__labgridServeStaged = (url, request) => {
  let u;
  try { u = new URL(url); } catch { return undefined; }
  if (u.hostname !== STAGE_HOST) return undefined;
  const body = staged.get(decodeURIComponent(u.pathname.split("/").pop()));
  return body ? Promise.resolve(stagedResponse(body, request)) : undefined;
};

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
 * Start the stack and resolve once its MITM CA has been written into Module's
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
