// Getting guest images into QEMU's filesystem, without an Emscripten toolchain.
//
// A guest is a plain JSON manifest sitting next to the QEMU binary:
//
//   {"files": [{"path": "/demo/images/mini.norimg",
//               "url": "images/mini.norimg"},
//              {"path": "/images/mini.hdimg"}]}
//
// "path" is where the file lands in the Emscripten filesystem -- the path QEMU
// will be told on its command line: labgrid resolves env.yaml images: keys
// against the config's directory (/demo), while relative paths in extra_args
// pass through verbatim and resolve against QEMU's cwd (/). "url" is where to
// fetch it from, resolved against the manifest, defaulting to the basename.
// A url ending in ".gz" (for a path that does not) is fetched compressed and
// inflated while it streams -- flash and disk images squash 3-60x, and
// counting on the server or its CDN to compress a 70 MB octet-stream on the
// fly is a losing bet (edge CDNs cap on-the-fly compression well below these
// sizes). setup.sh produces the .gz files; decompression is ~2 s and overlaps
// the transfer. Adding a guest is dropping files on a static server and
// editing this list. (Upstream qemu-wasm instead ships guests as emcc
// file_packager blobs, which only emsdk can produce; the loader for those
// left with the last packed image.)
//
// Why every file is fetched eagerly, rather than with FS_createLazyFile:
// createLazyFile is built on synchronous XHR, so it refuses outright to run
// outside a Web Worker ("Cannot do synchronous binary XHRs outside webworkers"
// -- it throws when the file is *created*, not when it is read), and preRun
// runs on the browser main thread. Even without that check it would be the
// wrong tool here: this build proxies every filesystem syscall to the main
// thread, so each lazy chunk fault would become a synchronous main-thread XHR
// in the middle of QEMU's I/O path -- the same starvation that already cost us
// the QMP monitor once. Eager fetch costs memory instead, and the bytes land in
// a JS-heap Uint8Array handed to the FS with canOwn, outside the wasm heap.

const MANIFEST = "guest.json";

/** Read <base>/guest.json. */
export async function fetchGuestManifest(base) {
  const url = new URL(MANIFEST, base).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const manifest = await res.json();
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(`${url}: expected {"files": [...]}`);
  }
  return manifest;
}

/**
 * Fetch into a Uint8Array, reporting progress as the body streams in.
 * Progress counts *transferred* bytes against Content-Length, so it stays
 * honest for a gzipped fetch; with gunzip the bytes are inflated between the
 * counter and the collector, overlapping the transfer.
 */
async function download(url, onProgress, gunzip = false) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let body = res.body;
  if (!body) { // no streaming support; rare, and progress is lost anyway
    body = new Blob([await res.arrayBuffer()]).stream();
  }
  let got = 0;
  let stream = body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      got += chunk.length;
      if (onProgress) onProgress(got, total);
      controller.enqueue(chunk);
    },
  }));
  if (gunzip) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Fetch every file in the manifest and arrange for it to appear in QEMU's
 * filesystem. Returns what was staged, as [{path, url, size}].
 *
 * The download happens now; the filesystem work is queued on Module.preRun,
 * because FS does not exist until the runtime starts and the files have to be
 * there the moment QEMU's main() looks for them. Call before the module is
 * initialized.
 */
export async function stageGuestFiles(Module, base, manifest, onProgress = null) {
  const staged = [];
  for (const entry of manifest.files) {
    const { path } = entry;
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error(`guest manifest: "path" must be absolute, got ${JSON.stringify(path)}`);
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    const url = new URL(entry.url || name, base).href;
    const gunzip = url.endsWith(".gz") && !path.endsWith(".gz");
    const data = await download(url, (got, total) => onProgress && onProgress(path, got, total), gunzip);
    staged.push({ path, url, size: data.length, data });
  }

  Module.preRun = Module.preRun || [];
  Module.preRun.push(() => {
    for (const file of staged) {
      const slash = file.path.lastIndexOf("/");
      const dir = file.path.slice(0, slash) || "/";
      const name = file.path.slice(slash + 1);
      // createDataFile joins dir and name but will not create missing parents
      if (dir !== "/") Module.FS_createPath("/", dir.slice(1), true, true);
      Module.FS_createDataFile(dir, name, file.data, true, true, true /* canOwn */);
      file.data = null; // the FS owns the buffer now
    }
  });

  return staged.map(({ path, url, size }) => ({ path, url, size }));
}
