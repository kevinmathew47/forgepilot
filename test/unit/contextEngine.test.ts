import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { coChangePartners, ContextEngine, globToRegExp, parseCoChange, tokenize } from "../../src/contextEngine";

let root = "";

const files: Record<string, string> = {
  "src/app/cli.py": [
    "import click",
    "",
    "def routes_command():",
    "    \"\"\"Show the routes for the app.\"\"\"",
    "    pass",
    "",
    "def shell_command():",
    "    \"\"\"Run an interactive shell.\"\"\"",
    "    pass",
    "",
  ].join("\n"),
  "src/app/helpers.py": ["def get_debug_flag():", "    return False", ""].join("\n"),
  "src/app/config.py": ["class Config(dict):", "    def from_mapping(self, mapping):", "        pass", ""].join("\n"),
  "tests/test_cli.py": ["from app.cli import routes_command", "", "def test_routes():", "    pass", ""].join("\n"),
  "docs/cli.rst": ["Command Line Interface", "======================", "", "Built-in commands: routes and shell.", ""].join("\n"),
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "forgepilot-unit-"));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("tokenize splits identifiers and drops stop words", () => {
  const t = tokenize("Add a getDebugFlag command to the CLI");
  assert.ok(t.includes("cli"));
  assert.ok(t.includes("debug"));
  assert.ok(!t.includes("the"));
});

test("glob patterns match paths", () => {
  assert.ok(globToRegExp("**/*.py").test("src/app/cli.py"));
  assert.ok(globToRegExp("*.rst").test("cli.rst"));
  assert.ok(!globToRegExp("*.rst").test("cli.py"));
});

test("a task naming no files finds source, test and docs", async () => {
  const engine = new ContextEngine(root);
  const sel = await engine.select("Add a new built-in CLI command, covered by a test and documented with the other commands", 4000);
  const chosen = sel.files.map((f) => f.path);
  assert.ok(chosen.includes("src/app/cli.py"));
  assert.ok(chosen.indexOf("src/app/cli.py") < chosen.indexOf("src/app/config.py") || !chosen.includes("src/app/config.py"));
  assert.ok(chosen.includes("tests/test_cli.py"));
  assert.ok(chosen.includes("docs/cli.rst"));
  assert.ok(sel.used <= 4000);
  assert.ok(sel.files.every((f) => f.reasons.length > 0));
});

test("an exact function name pulls in its definition", async () => {
  const engine = new ContextEngine(root);
  const sel = await engine.select("change get_debug_flag so that 'off' is false", 4000);
  assert.equal(sel.files[0].path, "src/app/helpers.py");
  assert.match(sel.files[0].reasons[0], /defines `get_debug_flag`/);
});

test("the token budget is respected", async () => {
  const engine = new ContextEngine(root);
  const sel = await engine.select("CLI command routes shell config", 120);
  assert.ok(sel.used <= 120);
});

test("git history is parsed into co-change partners", () => {
  const log = ["", "a.py\nb.py\n", "a.py\nb.py\nc.py\n", "a.py\n", "b.py\nc.py\n"].join("\x00");
  const data = parseCoChange(log);
  assert.equal(data.commits.get("a.py"), 3);
  const partners = coChangePartners(data, "a.py", 2, 8, 1);
  assert.equal(partners[0].path, "b.py");
  assert.equal(partners[0].shared, 2);
  assert.ok(Math.abs(partners[0].ratio - 2 / 3) < 1e-9);
  assert.ok(!partners.some((p) => p.path === "c.py"));
});

test("files touched by most commits are not treated as partners", () => {
  const commits = ["a.py\nCHANGES.rst\nb.py", "a.py\nCHANGES.rst\nb.py", "c.py\nCHANGES.rst", "d.py\nCHANGES.rst", "e.py\nCHANGES.rst", "f.py\nCHANGES.rst"];
  const data = parseCoChange(["", ...commits].join("\x00"));
  const partners = coChangePartners(data, "a.py").map((p) => p.path);
  assert.ok(partners.includes("b.py"));
  assert.ok(!partners.includes("CHANGES.rst"));
});

test("huge commits are ignored as noise", () => {
  const big = Array.from({ length: 40 }, (_, i) => `f${i}.py`).join("\n");
  const data = parseCoChange(["", big, "a.py\nb.py"].join("\x00"), 25);
  assert.equal(data.commits.get("f1.py"), undefined);
  assert.equal(data.commits.get("a.py"), 1);
});
