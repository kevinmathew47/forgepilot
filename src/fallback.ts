import { classifyError, TurnResult } from "./forge";

export type FallbackNotice =
  | { type: "attempt"; model: string; attempt: number }
  | { type: "retry"; model: string; attempt: number; delayMs: number; message: string }
  | { type: "fallback"; from: string; to: string; message: string }
  | { type: "exhausted"; message: string };

export interface FallbackResult extends TurnResult {
  model?: string;
  failures: { model: string; message: string }[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function runWithFallback(
  models: string[],
  retries: number,
  signal: AbortSignal,
  notify: (n: FallbackNotice) => void,
  attempt: (model: string, attemptNo: number) => Promise<TurnResult & { unrecoverable?: boolean }>,
): Promise<FallbackResult> {
  const failures: { model: string; message: string }[] = [];
  if (!models.length) {
    return { status: "error", message: "No model is configured in TrueForge. Add one under Settings → Models or run scripts/configure-models.mjs.", failures };
  }
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    for (let i = 0; i <= Math.max(retries, 12); i++) {
      if (signal.aborted) return { status: "cancelled", failures, model };
      notify({ type: "attempt", model, attempt: i + 1 });
      const r = await attempt(model, i);
      if (r.status !== "error") return { ...r, model, failures };
      const message = r.message ?? "unknown error";
      failures.push({ model, message });
      if (r.unrecoverable) return { ...r, model, failures };
      const kind = classifyError(message);
      if (/cannot reach truefoundry|cannot reach trueforge/i.test(message)) return { ...r, model, failures };
      const rateLimited = /\b429\b|rate.?limit|quota|resource.?exhausted|too many requests/i.test(message);
      const dailyQuota = rateLimited && /per.?day|daily/i.test(message);
      const permanent = kind === "auth" || kind === "model" || dailyQuota;
      const maxRetries = rateLimited ? Math.max(retries, 12) : retries;
      if (!permanent && i < maxRetries) {
        const hinted = message.match(/retry (?:in|after) ([\d.]+)\s*s/i) ?? message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
        const base = hinted ? Math.min(90, parseFloat(hinted[1]) + 1) * 1000 : rateLimited ? Math.min(60000, 20000 * 2 ** Math.min(i, 2)) : 1000 * 2 ** i;
        const delayMs = Math.round(base * (rateLimited ? 1 : 0.85 + Math.random() * 0.3));
        notify({ type: "retry", model, attempt: i + 1, delayMs, message });
        await sleep(delayMs, signal);
        continue;
      }
      const next = models[m + 1];
      if (next) notify({ type: "fallback", from: model, to: next, message });
      break;
    }
  }
  const summary = failures.map((f) => `${f.model}: ${f.message}`).join("\n");
  notify({ type: "exhausted", message: summary });
  return { status: "error", message: `Every configured model failed.\n${summary}`, failures };
}
