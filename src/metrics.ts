import { appendFileSync } from "node:fs";
import { apiCallCount } from "./sc-client.js";

// Opt-in: set SC_METRICS_FILE to append one JSON line per tool call (latency, ServiceChannel requests made, size of
// the result handed to the LLM). estTokens is bytes/4, a rough English/JSON estimate, not a real tokenizer count.
const METRICS_FILE = process.env.SC_METRICS_FILE;

export function toolMetric(tool: string, ms: number, apiCalls: number, result: any, error: boolean) {
  const text = (result?.content ?? []).map((c: any) => c?.text ?? "").join("");
  const bytes = Buffer.byteLength(text);
  return { ts: new Date().toISOString(), tool, ms, apiCalls, bytes, estTokens: Math.ceil(bytes / 4), error };
}

export function timed<A extends unknown[], R>(tool: string, handler: (...args: A) => Promise<R>) {
  if (!METRICS_FILE) return handler;
  return async (...args: A): Promise<R> => {
    const start = Date.now();
    const callsBefore = apiCallCount();
    let result: R | undefined;
    let failed = true;
    try {
      result = await handler(...args);
      failed = false;
      return result;
    } finally {
      try {
        const line = toolMetric(tool, Date.now() - start, apiCallCount() - callsBefore, result, failed);
        appendFileSync(METRICS_FILE, JSON.stringify(line) + "\n");
      } catch {
        // metrics must never break a tool call
      }
    }
  };
}
