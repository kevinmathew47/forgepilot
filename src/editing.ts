export interface TextEdit {
  old_text: string;
  new_text: string;
}

export class EditError extends Error {}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  const numbered = lines.filter((l) => /^\s*\d+[|:]\s?/.test(l)).length;
  if (lines.length > 0 && numbered === lines.filter((l) => l.trim()).length && numbered > 0) {
    return lines.map((l) => l.replace(/^\s*\d+[|:]\s?/, "")).join("\n");
  }
  return text;
}

function fuzzyLineMatch(content: string, oldText: string): { start: number; end: number }[] {
  const lines = content.split("\n");
  const target = oldText.split("\n").map((l) => l.trimEnd());
  while (target.length && target[target.length - 1].trim() === "") target.pop();
  while (target.length && target[0].trim() === "") target.shift();
  if (!target.length) return [];
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const targetNorm = target.map(norm);
  const matches: { start: number; end: number }[] = [];
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  for (let i = 0; i + targetNorm.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < targetNorm.length; j++) {
      if (norm(lines[i + j]) !== targetNorm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = i + targetNorm.length - 1;
      matches.push({ start: offsets[i], end: offsets[last] + lines[last].length });
    }
  }
  return matches;
}

function reindent(newText: string, matchedText: string, oldText: string): string {
  const firstIndent = (s: string) => {
    const line = s.split("\n").find((l) => l.trim());
    return line ? line.match(/^\s*/)![0] : "";
  };
  const want = firstIndent(matchedText);
  const have = firstIndent(oldText);
  if (want === have) return newText;
  return newText
    .split("\n")
    .map((l) => {
      if (!l.trim()) return l;
      if (l.startsWith(have)) return want + l.slice(have.length);
      return l;
    })
    .join("\n");
}

function nearestLines(content: string, oldText: string): string {
  const firstLine = oldText.split("\n").find((l) => l.trim())?.trim() ?? "";
  const words = firstLine.split(/\W+/).filter((w) => w.length > 2);
  const lines = content.split("\n");
  let best = -1;
  let bestScore = 0;
  lines.forEach((l, i) => {
    const score = words.filter((w) => l.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0) return "";
  const from = Math.max(0, best - 3);
  return lines
    .slice(from, best + 6)
    .map((l, i) => `${from + i + 1}| ${l}`)
    .join("\n");
}

export function applyTextEdits(content: string, edits: TextEdit[], path: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let text = content.replace(/\r\n/g, "\n");
  edits.forEach((edit, index) => {
    const oldText = stripLineNumbers((edit.old_text ?? "").replace(/\r\n/g, "\n"));
    const newText = (edit.new_text ?? "").replace(/\r\n/g, "\n");
    if (!oldText.trim()) {
      throw new EditError(`edit ${index + 1} in ${path}: old_text is empty. To create or fully replace a file use write_file.`);
    }
    const exact = countOccurrences(text, oldText);
    if (exact === 1) {
      text = text.replace(oldText, () => newText);
      return;
    }
    if (exact > 1) {
      throw new EditError(
        `edit ${index + 1} in ${path}: old_text matches ${exact} places. Include more surrounding lines so it is unique.`,
      );
    }
    const fuzzy = fuzzyLineMatch(text, oldText);
    if (fuzzy.length === 1) {
      const matched = text.slice(fuzzy[0].start, fuzzy[0].end);
      text = text.slice(0, fuzzy[0].start) + reindent(newText, matched, oldText).replace(/\n$/, "") + text.slice(fuzzy[0].end);
      return;
    }
    if (fuzzy.length > 1) {
      throw new EditError(
        `edit ${index + 1} in ${path}: old_text matches ${fuzzy.length} places (ignoring whitespace). Include more surrounding lines.`,
      );
    }
    const hint = nearestLines(text, oldText);
    throw new EditError(
      `edit ${index + 1} in ${path}: old_text was not found. The file does not contain that code; read_file it again and copy the exact lines.` +
        (hint ? `\nClosest lines in the file:\n${hint}` : ""),
    );
  });
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}
