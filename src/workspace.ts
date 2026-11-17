import * as vscode from "vscode";
import * as path from "path";

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("Open a folder in VS Code first.");
  return folder.uri.fsPath;
}

export function toRelative(p: string): string {
  const root = workspaceRoot();
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return path.relative(root, abs).split(path.sep).join("/");
}

export function resolvePath(rel: string): vscode.Uri {
  const root = workspaceRoot();
  const cleaned = rel.replace(/^\.?[\\/]/, "").replace(/^@/, "");
  const abs = path.resolve(root, cleaned);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error(`Path ${rel} is outside the workspace.`);
  }
  return vscode.Uri.file(abs);
}

export async function readDiskOrBuffer(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}
