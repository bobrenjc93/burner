import { randomUUID } from "node:crypto";

export const now = () => new Date().toISOString();

export const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export function wellFormedText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }
  return result;
}

export function truncateText(value: string, maxLength: number, fromEnd = false): string {
  const sliced = value.length <= maxLength
    ? value
    : fromEnd
      ? value.slice(-maxLength)
      : value.slice(0, maxLength);
  return wellFormedText(sliced);
}

export function slugify(value: string, maxLength = 42): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-$/g, "") || "improvement";
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function parseJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new Error("Codex returned invalid JSON");
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function weightedScore(
  evaluations: { id: string; weight: number; enabled: boolean }[],
  scores: Map<string, number>,
): number | undefined {
  let total = 0;
  let weights = 0;
  for (const evaluation of evaluations) {
    const score = scores.get(evaluation.id);
    if (!evaluation.enabled || score === undefined) continue;
    total += score * evaluation.weight;
    weights += evaluation.weight;
  }
  return weights ? Math.round((total / weights) * 10) / 10 : undefined;
}

export function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  return Promise.all(runners).then(() => results);
}
