import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithFallback, FallbackNotice } from "../../src/fallback";
import { classifyError } from "../../src/forge";

const ok = { status: "done" as const, text: "ok" };

test("error messages are classified", () => {
  assert.equal(classifyError("401 Incorrect API key provided"), "auth");
  assert.equal(classifyError("model gpt-x does not exist"), "model");
  assert.equal(classifyError("(HTTP 400) unrecognized field title"), "model");
  assert.equal(classifyError("429 Too Many Requests"), "transient");
  assert.equal(classifyError("connect ECONNREFUSED 127.0.0.1:8790"), "transient");
});

test("first healthy model wins without fallback", async () => {
  const notices: FallbackNotice[] = [];
  const r = await runWithFallback(["a", "b"], 2, new AbortController().signal, (n) => notices.push(n), async () => ok as any);
  assert.equal(r.status, "done");
  assert.equal(r.model, "a");
  assert.ok(!notices.some((n) => n.type === "fallback"));
});

test("a bad key falls back immediately without retrying", async () => {
  const calls: string[] = [];
  const notices: FallbackNotice[] = [];
  const r = await runWithFallback(["bad", "good"], 2, new AbortController().signal, (n) => notices.push(n), async (m) => {
    calls.push(m);
    return m === "bad" ? ({ status: "error", message: "401 Incorrect API key" } as any) : (ok as any);
  });
  assert.deepEqual(calls, ["bad", "good"]);
  assert.equal(r.model, "good");
  assert.ok(notices.some((n) => n.type === "fallback" && n.from === "bad" && n.to === "good"));
  assert.equal(r.failures.length, 1);
});

test("a daily quota switches model at once", async () => {
  const calls: string[] = [];
  await runWithFallback(["a", "b"], 2, new AbortController().signal, () => {}, async (m) => {
    calls.push(m);
    return m === "a" ? ({ status: "error", message: "429 quota exceeded: requests per day" } as any) : (ok as any);
  });
  assert.deepEqual(calls, ["a", "b"]);
});

test("a per-minute limit waits for the server's hint and retries the same model", async () => {
  const notices: FallbackNotice[] = [];
  let n = 0;
  const r = await runWithFallback(["a", "b"], 2, new AbortController().signal, (x) => notices.push(x), async () =>
    n++ === 0 ? ({ status: "error", message: "429 rate limit, please retry in 0.05s" } as any) : (ok as any),
  );
  assert.equal(r.model, "a");
  const retry = notices.find((x) => x.type === "retry");
  assert.ok(retry && retry.type === "retry" && retry.delayMs >= 1000 && retry.delayMs < 1200);
});

test("every model failing gives one clear error", async () => {
  const r = await runWithFallback(["a", "b"], 0, new AbortController().signal, () => {}, async (m) => ({ status: "error", message: `401 bad key for ${m}` }) as any);
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /Every configured model failed/);
  assert.match(r.message ?? "", /a: 401/);
  assert.match(r.message ?? "", /b: 401/);
});

test("no models configured is reported, not thrown", async () => {
  const r = await runWithFallback([], 2, new AbortController().signal, () => {}, async () => ok as any);
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /No model is configured/);
});

test("cancelling stops before the next attempt", async () => {
  const ac = new AbortController();
  ac.abort();
  let called = false;
  const r = await runWithFallback(["a"], 2, ac.signal, () => {}, async () => {
    called = true;
    return ok as any;
  });
  assert.equal(r.status, "cancelled");
  assert.equal(called, false);
});
