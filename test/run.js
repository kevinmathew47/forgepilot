const path = require("path");
const os = require("os");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const workspace = process.env.FP_WORKSPACE || path.resolve(__dirname, "../../flask");
  const ext = process.env.FP_EXT || path.resolve(__dirname, "..");
  const exe = process.env.VSCODE_EXE || path.join(os.homedir(), "AppData/Local/Programs/Microsoft VS Code/Code.exe");
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(ext, "test", "suite.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", path.join(os.tmpdir(), "forgepilot-test-profile")],
    extensionTestsEnv: { FP_SCENARIO: process.env.FP_SCENARIO || "taskA", FP_MODELS: process.env.FP_MODELS || "", FP_VIDEO: process.env.FP_VIDEO || "" },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
