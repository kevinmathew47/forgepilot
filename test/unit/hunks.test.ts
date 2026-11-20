import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHunks, composeText, countChanges, finalText, previewText } from "../../src/hunks";

const original = ["def a():", "    return 1", "", "def b():", "    return 2", "", "def c():", "    return 3", ""].join("\n");
const proposed = ["def a():", "    return 10", "", "def b():", "    return 2", "", "def c():", "    return 30", ""].join("\n");

test("separate changes become separate hunks", () => {
  const hunks = computeHunks(original, proposed);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].origLines, ["    return 1"]);
  assert.deepEqual(hunks[0].newLines, ["    return 10"]);
  assert.deepEqual(hunks[1].newLines, ["    return 30"]);
});

test("accepting only one hunk keeps the other line unchanged", () => {
  const hunks = computeHunks(original, proposed);
  hunks[0].state = "accepted";
  hunks[1].state = "rejected";
  const out = finalText(original, hunks);
  assert.match(out, /return 10/);
  assert.match(out, /return 3\n/);
  assert.doesNotMatch(out, /return 30/);
});

test("rejecting every hunk returns the original text", () => {
  const hunks = computeHunks(original, proposed);
  hunks.forEach((h) => (h.state = "rejected"));
  assert.equal(finalText(original, hunks), original);
});

test("preview shows every pending hunk", () => {
  const hunks = computeHunks(original, proposed);
  assert.equal(previewText(original, hunks), proposed);
});

test("compose honours the include predicate", () => {
  const hunks = computeHunks(original, proposed);
  assert.equal(composeText(original, hunks, () => true), proposed);
  assert.equal(composeText(original, hunks, () => false), original);
});

test("windows line endings are preserved", () => {
  const crlf = original.replace(/\n/g, "\r\n");
  const hunks = computeHunks(crlf, proposed.replace(/\n/g, "\r\n"));
  hunks.forEach((h) => (h.state = "accepted"));
  const out = finalText(crlf, hunks);
  assert.ok(out.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(out));
});

test("added and removed lines are counted", () => {
  const { added, removed } = countChanges(computeHunks(original, proposed));
  assert.equal(added, 2);
  assert.equal(removed, 2);
});

test("identical text has no hunks", () => {
  assert.equal(computeHunks(original, original).length, 0);
});
