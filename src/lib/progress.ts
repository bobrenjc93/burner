import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Evaluation } from "../types.js";

export type ProgressPoint = {
  key: string;
  recordedAt: string;
  label: string;
  kind: "baseline" | "leaf" | "composite";
  prNumber?: number;
  title: string;
  scores: Record<string, number>;
};

type ProgressHistory = {
  version: 1;
  evaluations: Record<string, { name: string; color: string }>;
  points: ProgressPoint[];
};

const HISTORY_PATH = "docs/burner-evaluation-history.json";
const GRAPH_PATH = "docs/burner-evaluation-progress.svg";
const START = "<!-- burner-progress:start -->";
const END = "<!-- burner-progress:end -->";
const COLORS = ["#ff6b35", "#7c5cff", "#00a7a5", "#e6a700", "#d94f8a", "#2589bd", "#5b8c36", "#9c6644", "#6c757d", "#ef476f"];

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

function emptyHistory(): ProgressHistory {
  return { version: 1, evaluations: {}, points: [] };
}

async function readHistory(cwd: string): Promise<ProgressHistory> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, HISTORY_PATH), "utf8")) as Partial<ProgressHistory>;
    if (parsed.version !== 1 || !parsed.evaluations || !Array.isArray(parsed.points)) throw new Error("unsupported history format");
    return parsed as ProgressHistory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHistory();
    throw new Error(`Could not read ${HISTORY_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderSvg(history: ProgressHistory): string {
  const width = 1200;
  const legendRows = Math.max(1, Math.ceil(Object.keys(history.evaluations).length / 2));
  const height = 420 + legendRows * 28;
  const left = 70;
  const right = 32;
  const top = 54;
  const bottom = 90 + legendRows * 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = (index: number) => history.points.length <= 1 ? left + plotWidth / 2 : left + (index / (history.points.length - 1)) * plotWidth;
  const y = (score: number) => top + (1 - Math.max(0, Math.min(100, score)) / 100) * plotHeight;
  const evaluationEntries = Object.entries(history.evaluations);
  const grid = [0, 25, 50, 75, 100].map((score) => `<line x1="${left}" y1="${y(score)}" x2="${width - right}" y2="${y(score)}" class="grid"/><text x="${left - 12}" y="${y(score) + 5}" text-anchor="end" class="axis">${score}</text>`).join("");
  const labelIndexes = history.points.length <= 8
    ? history.points.map((_point, index) => index)
    : [...new Set(Array.from({ length: 8 }, (_value, index) => Math.round(index * (history.points.length - 1) / 7)))];
  const xLabels = labelIndexes.map((index) => `<text x="${x(index)}" y="${top + plotHeight + 28}" text-anchor="middle" class="axis">${escapeXml(history.points[index]!.label)}</text>`).join("");
  const lines = evaluationEntries.map(([evaluationId, evaluation]) => {
    const points = history.points.flatMap((point, index) => Number.isFinite(point.scores[evaluationId]) ? [`${x(index).toFixed(1)},${y(point.scores[evaluationId]!).toFixed(1)}`] : []);
    if (!points.length) return "";
    const dots = history.points.length <= 60 ? points.map((point) => { const [cx, cy] = point.split(","); return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="${evaluation.color}"/>`; }).join("") : "";
    return `<polyline points="${points.join(" ")}" fill="none" stroke="${evaluation.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join("");
  const legend = evaluationEntries.map(([_evaluationId, evaluation], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const legendX = left + column * (plotWidth / 2);
    const legendY = top + plotHeight + 66 + row * 28;
    return `<line x1="${legendX}" y1="${legendY}" x2="${legendX + 26}" y2="${legendY}" stroke="${evaluation.color}" stroke-width="4"/><text x="${legendX + 36}" y="${legendY + 5}" class="legend">${escapeXml(evaluation.name)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Burner evaluation progress</title><desc id="desc">Time series of evaluation scores recorded at each Burner merge.</desc>
<style>text{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.title{font-size:22px;font-weight:700;fill:#20242a}.axis{font-size:12px;fill:#59636e}.legend{font-size:13px;fill:#2f3740}.grid{stroke:#d8dee5;stroke-width:1}.plot{fill:#fff;stroke:#b7c0ca}</style>
<rect width="100%" height="100%" fill="#f8fafc" rx="14"/><text x="${left}" y="32" class="title">Burner evaluation progress</text>
<rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" class="plot"/>${grid}${lines}${xLabels}${legend}
</svg>
`;
}

function readmeBlock(): string {
  return `${START}\n## Burner evaluation progress\n\n![Burner evaluation progress](${GRAPH_PATH})\n\n_Updated automatically on every Burner merge. [Raw history](${HISTORY_PATH})._\n${END}`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

export async function updateProgressArtifacts(cwd: string, evaluations: Evaluation[], newPoints: ProgressPoint[]): Promise<ProgressHistory> {
  const history = await readHistory(cwd);
  for (const evaluation of evaluations.filter((item) => item.enabled)) {
    const existing = history.evaluations[evaluation.id];
    history.evaluations[evaluation.id] = { name: evaluation.name, color: existing?.color ?? COLORS[Object.keys(history.evaluations).length % COLORS.length]! };
  }
  for (const point of newPoints) {
    const existingIndex = history.points.findIndex((item) => item.key === point.key);
    if (existingIndex >= 0) history.points[existingIndex] = { ...point, recordedAt: history.points[existingIndex]!.recordedAt };
    else history.points.push(point);
  }
  history.points.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  await atomicWrite(join(cwd, HISTORY_PATH), `${JSON.stringify(history, null, 2)}\n`);
  await atomicWrite(join(cwd, GRAPH_PATH), renderSvg(history));
  const readmePath = join(cwd, "README.md");
  let readme = "";
  try { readme = await readFile(readmePath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const block = readmeBlock();
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start >= 0 && end >= start) readme = `${readme.slice(0, start)}${block}${readme.slice(end + END.length)}`;
  else readme = `${readme.trimEnd()}${readme.trim() ? "\n\n" : ""}${block}\n`;
  await atomicWrite(readmePath, readme);
  return history;
}
