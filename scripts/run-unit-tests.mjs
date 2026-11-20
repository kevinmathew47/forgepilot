import * as esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

const srcDir = "test/unit";
const outDir = "out/unit";
const entries = readdirSync(srcDir).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(srcDir, f));

rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: entries,
  bundle: true,
  outdir: outDir,
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  mainFields: ["module", "main"],
  conditions: ["require", "node"],
  logLevel: "warning",
});

const files = readdirSync(outDir).filter((f) => f.endsWith(".cjs")).map((f) => path.join(outDir, f));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
