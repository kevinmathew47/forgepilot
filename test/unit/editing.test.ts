import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits, EditError } from "../../src/editing";

const source = ["class App:", "    def run(self):", "        debug = False", "        return debug", ""].join("\n");

test("exact match replaces the text", () => {
  const out = applyTextEdits(source, [{ old_text: "debug = False", new_text: "debug = True" }], "app.py");
  assert.match(out, /debug = True/);
});

test("several edits apply in order", () => {
  const out = applyTextEdits(
    source,
    [
      { old_text: "def run(self):", new_text: "def start(self):" },
      { old_text: "return debug", new_text: "return not debug" },
    ],
    "app.py",
  );
  assert.match(out, /def start/);
  assert.match(out, /return not debug/);
});

test("whitespace differences are tolerated and indentation is kept", () => {
  const out = applyTextEdits(source, [{ old_text: "debug = False\nreturn debug", new_text: "debug = True\nreturn debug" }], "app.py");
  assert.match(out, /\n {8}debug = True\n {8}return debug/);
});

test("line-number prefixes copied from read_file are ignored", () => {
  const out = applyTextEdits(source, [{ old_text: "3|         debug = False", new_text: "        debug = None" }], "app.py");
  assert.match(out, /debug = None/);
});

test("ambiguous text is rejected", () => {
  const twice = source + source;
  assert.throws(() => applyTextEdits(twice, [{ old_text: "debug = False", new_text: "x" }], "app.py"), EditError);
});

test("missing text is rejected with a hint", () => {
  assert.throws(
    () => applyTextEdits(source, [{ old_text: "debug = Maybe", new_text: "x" }], "app.py"),
    (e: Error) => e instanceof EditError && /not found/.test(e.message),
  );
});

test("empty old_text is rejected", () => {
  assert.throws(() => applyTextEdits(source, [{ old_text: "  ", new_text: "x" }], "app.py"), EditError);
});

test("windows line endings survive an edit", () => {
  const crlf = source.replace(/\n/g, "\r\n");
  const out = applyTextEdits(crlf, [{ old_text: "debug = False", new_text: "debug = True" }], "app.py");
  assert.ok(out.includes("debug = True\r\n"));
});
