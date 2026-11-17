import { diffLines } from "diff";

export type HunkState = "pending" | "accepted" | "rejected";

export interface Hunk {
  id: number;
  origStart: number;
  origLines: string[];
  newLines: string[];
  state: HunkState;
}

export function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = original.replace(/\r\n/g, "\n");
  const b = proposed.replace(/\r\n/g, "\n");
  const parts = diffLines(a, b);
  const hunks: Hunk[] = [];
  let line = 0;
  let current: Hunk | undefined;
  const toLines = (value: string) => {
    const lines = value.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  for (const part of parts) {
    const lines = toLines(part.value);
    if (!part.added && !part.removed) {
      if (current) {
        hunks.push(current);
        current = undefined;
      }
      line += lines.length;
      continue;
    }
    if (!current) {
      current = { id: hunks.length, origStart: line, origLines: [], newLines: [], state: "pending" };
    }
    if (part.removed) {
      current.origLines.push(...lines);
      line += lines.length;
    } else {
      current.newLines.push(...lines);
    }
  }
  if (current) hunks.push(current);
  hunks.forEach((h, i) => (h.id = i));
  return hunks;
}

export function composeText(original: string, hunks: Hunk[], include: (h: Hunk) => boolean): string {
  const eol = detectEol(original);
  const normalized = original.replace(/\r\n/g, "\n");
  const endsWithNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (endsWithNewline) lines.pop();
  const out: string[] = [];
  let cursor = 0;
  for (const h of [...hunks].sort((x, y) => x.origStart - y.origStart)) {
    while (cursor < h.origStart) out.push(lines[cursor++]);
    if (include(h)) out.push(...h.newLines);
    else out.push(...h.origLines);
    cursor += h.origLines.length;
  }
  while (cursor < lines.length) out.push(lines[cursor++]);
  let text = out.join("\n");
  if (endsWithNewline || (original.length === 0 && text.length > 0)) text += "\n";
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

export function previewText(original: string, hunks: Hunk[]): string {
  return composeText(original, hunks, (h) => h.state !== "rejected");
}

export function finalText(original: string, hunks: Hunk[]): string {
  return composeText(original, hunks, (h) => h.state === "accepted");
}

export function hunkPreviewRange(hunks: Hunk[], target: Hunk): { start: number; length: number } {
  let delta = 0;
  for (const h of [...hunks].sort((x, y) => x.origStart - y.origStart)) {
    if (h === target) break;
    if (h.state !== "rejected") delta += h.newLines.length - h.origLines.length;
  }
  const length = target.state === "rejected" ? target.origLines.length : target.newLines.length;
  return { start: target.origStart + delta, length };
}

export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  return hunks.reduce(
    (acc, h) => ({ added: acc.added + h.newLines.length, removed: acc.removed + h.origLines.length }),
    { added: 0, removed: 0 },
  );
}
