const vscode = require("vscode");
const path = require("path");
const { execSync } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[forgepilot-test]", ...a);
const state = () => vscode.commands.executeCommand("forgepilot._state");
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const git = () => execSync("git status --short", { cwd: root() }).toString().trim();

async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (pred(s)) return s;
    await sleep(50);
  }
  throw new Error("timeout waiting for " + label);
}

async function openHelpers() {
  const uri = vscode.Uri.file(path.join(root(), "src/flask/helpers.py"));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const lines = doc.getText().split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("def get_debug_flag")) + 1;
  let end = start;
  while (end < lines.length && (lines[end] === "" || lines[end].startsWith(" "))) end++;
  while (lines[end - 1] === "") end--;
  return { doc, start, end };
}

const INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

async function setModels(models) {
  await vscode.workspace.getConfiguration("forgepilot").update("models", models, vscode.ConfigurationTarget.Global);
  await sleep(500);
}

const VIDEO = process.env.FP_VIDEO === "1";

async function showVerify(title, commands, holdMs) {
  if (!VIDEO) return;
  await vscode.commands.executeCommand("notifications.clearAll");
  const term = vscode.window.createTerminal({ name: title, cwd: require("fs").realpathSync.native(root()) });
  term.show(false);
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
  await sleep(7000);
  for (const c of commands) {
    term.sendText(c, true);
    await sleep(2500);
  }
  await sleep(holdMs);
}

async function taskA(models, expectApply) {
  await setModels(models);
  const { start, end } = await openHelpers();
  log("selection", start, end, "models", models.join(" -> "));
  const t0 = Date.now();
  const run = vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: INSTRUCTION, startLine: start, endLine: end });
  if (!expectApply) {
    await run;
    log("finished in", (Date.now() - t0) / 1000, "s; git status:", JSON.stringify(git()));
    return;
  }
  let sawStreaming = false;
  let finished = false;
  run.then(() => (finished = true));
  const s = await waitFor((x) => {
    if (finished && !x.reviewActive) throw new Error("inline edit ended without a proposal");
    if (x.review && x.review.streaming) sawStreaming = true;
    return x.review && !x.review.streaming && x.review.files[0].hunks.length > 0;
  }, 600000, "proposal");
  log("streamed:", sawStreaming, "hunks:", s.review.files[0].hunks.length, "after", (Date.now() - t0) / 1000, "s");
  for (const h of s.review.files[0].hunks) log("hunk", h.id, h.state, "\n" + h.preview);
  log("git during review (must be clean):", JSON.stringify(git()));
  if (VIDEO) {
    await vscode.commands.executeCommand("notifications.clearAll");
    try { await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange"); } catch {}
    await sleep(6000);
  }
  await vscode.commands.executeCommand("forgepilot.acceptAll");
  await run;
  const after = await state();
  log("history size", after.historySize, "git after apply:", JSON.stringify(git()));
  const py = path.join(root(), ".venv/Scripts/python.exe");
  for (const v of ["off", "OFF", "n", "no", "false", "0", "1", "on"]) {
    const out = execSync(`"${py}" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`, { cwd: root(), env: { ...process.env, FLASK_DEBUG: v } }).toString().trim();
    log(`FLASK_DEBUG=${v} ->`, out);
  }
  log(execSync("git diff", { cwd: root() }).toString());
  await showVerify("Task A check", [
    "foreach ($v in 'off','OFF','n','no','false','0','1','on') { $env:FLASK_DEBUG=$v; Write-Host \"FLASK_DEBUG=$v ->\" (.venv\\Scripts\\python -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())') }",
    "git status --short",
  ], 5000);
  await vscode.commands.executeCommand("forgepilot.undoLast");
  await sleep(800);
  log("git after undo (must be clean):", JSON.stringify(git()));
  await showVerify("After undo", ["git status; Write-Host 'clean after undo'"], 4000);
}

async function cancelTest(models) {
  await setModels(models);
  const { start, end } = await openHelpers();
  const run = vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: INSTRUCTION, startLine: start, endLine: end });
  await waitFor((x) => x.running, 30000, "run start");
  const seen = await waitFor((x) => (x.review && x.review.streaming) || x.reviewActive || !x.running, 120000, "first streamed tokens");
  log("state before cancel: streaming", !!(seen.review && seen.review.streaming), "reviewActive", seen.reviewActive, "running", seen.running);
  const t0 = Date.now();
  await vscode.commands.executeCommand("forgepilot.cancel");
  await run;
  const s = await state();
  log("cancel took", Date.now() - t0, "ms; reviewActive", s.reviewActive, "running", s.running, "git:", JSON.stringify(git()));
  await showVerify("After cancel", ["git status; Write-Host 'cancelled: nothing changed'"], 4000);
}

const TASK_B = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;

async function taskB(models) {
  await setModels(models);
  const t0 = Date.now();
  let done = false;
  const run = vscode.commands.executeCommand("forgepilot.runAgent", TASK_B).then(() => (done = true));
  let reviews = 0;
  while (!done && Date.now() - t0 < 1500000) {
    const s = await state();
    if (s.review && !s.review.streaming && s.review.files.some((f) => f.hunks.some((h) => h.state === "pending"))) {
      reviews++;
      log("review", reviews, s.review.files.map((f) => `${f.path} (+${f.added} -${f.removed}, ${f.hunks.length} hunks)`).join("; "));
      log("git during review (must be clean):", JSON.stringify(git()));
      if (VIDEO) {
        await vscode.commands.executeCommand("notifications.clearAll");
        try { await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange"); } catch {}
        await sleep(7000);
      }
      await vscode.commands.executeCommand("forgepilot.acceptAll");
    }
    await sleep(1000);
  }
  await run;
  log("agent finished in", (Date.now() - t0) / 1000, "s; reviews", reviews);
  log(execSync("git status --short && git diff --stat", { cwd: root() }).toString());
  const py = path.join(root(), ".venv/Scripts/python.exe");
  try {
    log(execSync(`"${py}" -m pytest tests/test_cli.py -q`, { cwd: require("fs").realpathSync.native(root()) }).toString().trim().split(/\r?\n/).slice(-2).join(" | "));
  } catch (e) {
    log("pytest failed", String(e.stdout).slice(-1500));
  }
  await showVerify("Task B check", [
    "git diff --stat",
    ".venv\\Scripts\\python -m pytest tests/test_cli.py -q",
    ".venv\\Scripts\\flask --help",
    "Push-Location D:\\fp-ext\\examples\\demoapp; D:\\fp-flask-clean\\.venv\\Scripts\\flask --app app config; Pop-Location",
  ], 9000);
}

async function run() {
  await vscode.extensions.getExtension("kevinmathew47.forgepilot").activate();
  await waitFor((s) => s.connected, 30000, "TrueForge connection");
  const scenario = process.env.FP_SCENARIO;
  const models = (process.env.FP_MODELS || "ollama/qwen2-5-7b").split(",");
  log("scenario", scenario);
  if (scenario === "taskA") await taskA(models, true);
  if (scenario === "taskC") await taskA(models, models.length > 1);
  if (scenario === "cancel") await cancelTest(models);
  if (scenario === "taskB") await taskB(models);
  if (scenario === "verifyB") await showVerify("Task B check", [
    "git diff --stat",
    ".venv\\Scripts\\python -m pytest tests/test_cli.py -q",
    ".venv\\Scripts\\flask --help",
    "Push-Location D:\\fp-ext\\examples\\demoapp; D:\\fp-flask-clean\\.venv\\Scripts\\flask --app app config; Pop-Location",
  ], 12000);
}

module.exports = { run };
