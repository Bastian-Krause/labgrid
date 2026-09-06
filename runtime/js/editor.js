// The pane's other two tabs: the environment config, read-only, and the test
// suite, editable.
//
// Edits land in Pyodide's filesystem and nowhere else -- no server, no browser
// storage -- so a reload restores whatever the server serves. The write happens
// when you leave the tab, which is exhaustive because reaching anything that
// reads the file (the prompt, above all) means leaving it. That also keeps the
// rule easy to state: what is on disk is what the editor showed when you last
// switched away.

const DEMO = new URL("../../demo/", import.meta.url).href;

const FILES = {
  yaml: { url: DEMO + "env.yaml", path: "/demo/env.yaml", language: "yaml", readonly: true },
  test: {
    url: DEMO + "tests/test_demo.py",
    path: "/demo/tests/test_demo.py",
    language: "python",
    readonly: false,
  },
  // editable too: it is where the run's arguments live, so changing -ra to -v
  // here is the way to see a different pytest report
  ini: { url: DEMO + "pytest.ini", path: "/demo/pytest.ini", language: "ini", readonly: false },
};

/**
 * Wire the tab strip and build the two editors.
 *
 * writeFile(path, source) is expected to resolve once the worker has the file;
 * the caller keeps that promise so the prompt can await it before running a
 * line. Switching tabs deliberately does *not* await: during a pytest run the
 * worker is blocked, so the reply cannot arrive until the run ends, and waiting
 * for it would look like a frozen UI.
 */
export function initEditors({ writeFile, onPendingWrite }) {
  const editors = {};
  const written = {}; // last text handed to the worker, to skip no-op writes

  for (const [name, file] of Object.entries(FILES)) {
    const flask = new CodeFlask(document.getElementById(`view-${name}`), {
      language: file.language,
      lineNumbers: true,
      readonly: file.readonly,
      defaultTheme: false, // index.html styles the tokens to match the pane
    });
    editors[name] = flask;

    fetch(file.url)
      .then((res) => res.text())
      .then((src) => {
        written[name] = src;
        flask.updateCode(src);
      });
  }

  /** Hand the tab's current text to the worker, unless it is unchanged. */
  function flush(name) {
    const file = FILES[name];
    if (!file || file.readonly) return;
    const code = editors[name].getCode();
    if (code === written[name]) return;
    written[name] = code;
    onPendingWrite(writeFile(file.path, code));
  }

  const tabs = [...document.querySelectorAll("#tabs button")];
  const panels = {
    repl: document.getElementById("repl-scroll"),
    yaml: document.getElementById("view-yaml"),
    test: document.getElementById("view-test"),
    ini: document.getElementById("view-ini"),
  };
  let current = "repl";

  function show(name) {
    if (name === current) return;
    flush(current);
    current = name;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
    // CodeFlask measures itself on creation, so a tab built while hidden needs
    // a nudge once it has a size to fill.
    if (editors[name]) editors[name].updateCode(editors[name].getCode());
  }

  for (const tab of tabs) tab.addEventListener("click", () => show(tab.dataset.view));

  return { show, flush, editors, get current() { return current; } };
}
