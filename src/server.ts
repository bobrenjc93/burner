import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "./lib/events.js";
import { Orchestrator } from "./lib/orchestrator.js";
import { StateStore, validateEvaluation } from "./lib/store.js";
import type { BurnerSettings, Idea } from "./types.js";
import { errorMessage, id, now } from "./lib/utils.js";

export type BurnerServerOptions = { root: string; host: string; port: number; dev?: boolean; yolo?: boolean; yoloBatchSize?: number };

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };
type Handler = (request: IncomingMessage, response: ServerResponse, params: Record<string, string>, body: Record<string, unknown>) => Promise<void> | void;

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!["POST", "PUT", "PATCH"].includes(request.method ?? "")) return {};
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request body is too large.");
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => { keys.push(key); return "([^/]+)"; });
  return { method, pattern: new RegExp(`^${pattern}$`), keys, handler };
}

function validateSettings(input: Record<string, unknown>): BurnerSettings {
  const integer = (key: string, min: number, max: number) => {
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    return value;
  };
  const text = (key: string) => {
    const value = String(input[key] ?? "").trim();
    if (!value || value.length > 200) throw new Error(`${key} is required.`);
    return value;
  };
  const number = (key: string, min: number, max: number) => {
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    return value;
  };
  return {
    parallelism: integer("parallelism", 1, 12),
    evaluationIntervalMinutes: integer("evaluationIntervalMinutes", 1, 10_080),
    orchestratorIntervalMinutes: integer("orchestratorIntervalMinutes", 1, 10_080),
    autoRun: Boolean(input.autoRun),
    autoCreatePrs: Boolean(input.autoCreatePrs),
    evaluatorModel: String(input.evaluatorModel ?? "").trim().slice(0, 120),
    agentModel: String(input.agentModel ?? "").trim().slice(0, 120),
    baseBranch: text("baseBranch"),
    remote: text("remote"),
    defaultResources: Array.isArray(input.defaultResources) ? input.defaultResources.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 20) : [],
    maxReviewRounds: integer("maxReviewRounds", 1, 50),
    portfolioReviewRounds: integer("portfolioReviewRounds", 1, 10),
    mergeCadenceMinutes: integer("mergeCadenceMinutes", 5, 10_080),
    preferLivingComposite: Boolean(input.preferLivingComposite),
    compositeAbsorbThreshold: number("compositeAbsorbThreshold", 0, 100),
  };
}

export async function createBurnerServer(options: BurnerServerOptions) {
  const root = resolve(options.root);
  const store = new StateStore(root);
  await store.init();
  const events = new EventHub();
  const orchestrator = new Orchestrator(root, store, events, { yolo: options.yolo, yoloBatchSize: options.yoloBatchSize });
  await orchestrator.init();
  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  if (!existsSync(publicDir)) throw new Error(`Burner web assets are missing at ${publicDir}. Run npm run build.`);

  const routes: Route[] = [
    route("GET", "/api/health", (_request, response) => { json(response, 200, { ok: true, project: store.get().projectName }); }),
    route("GET", "/api/dashboard", async (_request, response) => {
      const scores = store.compositeScores();
      json(response, 200, { state: store.get(), runtime: await orchestrator.runtimeStatus(), compositeScore: scores.current, previousCompositeScore: scores.previous });
    }),
    route("GET", "/api/events", (request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      const remove = events.add(response);
      request.on("close", remove);
    }),
    route("POST", "/api/evaluations", async (_request, response, _params, body) => {
      const input = validateEvaluation(body);
      const evaluation = { ...input, id: id("eval"), createdAt: now() };
      await store.update((state) => state.evaluations.push(evaluation));
      await store.addActivity({ type: "evaluation", message: `Evaluation added: ${evaluation.name}` });
      events.emit("state", store.get());
      json(response, 201, evaluation);
    }),
    route("PUT", "/api/evaluations/:evaluationId", async (_request, response, params, body) => {
      const input = validateEvaluation(body);
      let found = false;
      await store.update((state) => {
        const evaluation = state.evaluations.find((item) => item.id === params.evaluationId);
        if (evaluation) { Object.assign(evaluation, input); found = true; }
      });
      if (!found) return json(response, 404, { error: "Evaluation not found" });
      events.emit("state", store.get());
      json(response, 200, { ok: true });
    }),
    route("DELETE", "/api/evaluations/:evaluationId", async (_request, response, params) => {
      const before = store.get().evaluations.length;
      await store.update((state) => { state.evaluations = state.evaluations.filter((item) => item.id !== params.evaluationId); });
      if (store.get().evaluations.length === before) return json(response, 404, { error: "Evaluation not found" });
      events.emit("state", store.get());
      response.writeHead(204).end();
    }),
    route("POST", "/api/evaluations/run", (_request, response) => {
      json(response, 202, { accepted: true });
      void orchestrator.runEvaluations("manual").catch(async (error) => {
        await store.addActivity({ type: "error", message: "Evaluation run failed", detail: errorMessage(error) });
        events.emit("error", { message: errorMessage(error) });
      });
    }),
    route("POST", "/api/orchestrator/start", async (_request, response) => { await orchestrator.setEnabled(true); json(response, 200, { enabled: true }); }),
    route("POST", "/api/orchestrator/pause", async (_request, response) => { await orchestrator.setEnabled(false); json(response, 200, { enabled: false }); }),
    route("POST", "/api/orchestrator/cycle", (_request, response) => { json(response, 202, { accepted: true }); void orchestrator.runCycle(); }),
    route("POST", "/api/orchestrator/plan", (_request, response) => {
      json(response, 202, { accepted: true });
      void orchestrator.plan().catch(async (error) => {
        await store.addActivity({ type: "error", message: "Planning failed", detail: errorMessage(error) });
        events.emit("error", { message: errorMessage(error) });
      });
    }),
    route("POST", "/api/ideas", async (_request, response, _params, body) => {
      const title = String(body.title ?? "").trim();
      const description = String(body.description ?? "").trim();
      if (!title || !description) throw new Error("Idea title and description are required.");
      const timestamp = now();
      const currentState = store.get();
      const idea: Idea = {
        id: id("idea"), title: title.slice(0, 120), description,
        rationale: String(body.rationale ?? "Manually queued improvement").trim(),
        predictedImpact: Math.max(0, Math.min(100, Number(body.predictedImpact ?? 50))),
        evaluationIds: Array.isArray(body.evaluationIds) ? body.evaluationIds.map(String) : [],
        resources: Array.isArray(body.resources) ? body.resources.map(String) : [],
        status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "manual",
        baseCompositeId: currentState.settings.preferLivingComposite ? currentState.orchestrator.livingCompositeId : undefined,
      };
      await store.update((state) => state.ideas.push(idea));
      await store.addActivity({ type: "idea", message: `Idea queued: ${idea.title}` });
      events.emit("state", store.get());
      json(response, 201, idea);
    }),
    route("POST", "/api/ideas/:ideaId/status", async (_request, response, params, body) => {
      const status = body.status as Idea["status"];
      if (!new Set<Idea["status"]>(["queued", "dismissed"]).has(status)) return json(response, 400, { error: "Status must be queued or dismissed." });
      let found = false;
      await store.update((state) => {
        const idea = state.ideas.find((item) => item.id === params.ideaId);
        if (idea && !["running", "completed"].includes(idea.status)) { idea.status = status; idea.updatedAt = now(); found = true; }
      });
      if (!found) return json(response, 404, { error: "Idea not found or cannot be changed." });
      events.emit("state", store.get());
      json(response, 200, { ok: true });
    }),
    route("POST", "/api/agents/:runId/retry", (_request, response, params) => {
      const run = store.get().agentRuns.find((item) => item.id === params.runId);
      if (!run) return json(response, 404, { error: "Agent run not found." });
      if (run.status !== "failed") return json(response, 409, { error: "Only a failed agent run can be retried." });
      json(response, 202, { accepted: true });
      void orchestrator.retryAgent(params.runId).catch(async (error) => {
        await store.addActivity({ type: "error", message: `Agent retry failed: ${params.runId}`, detail: errorMessage(error) });
        events.emit("error", { message: errorMessage(error) });
      });
    }),
    route("POST", "/api/composites", async (_request, response, _params, body) => {
      const agentRunIds = Array.isArray(body.agentRunIds) ? body.agentRunIds.map(String) : [];
      const composite = await orchestrator.createComposite(agentRunIds, String(body.title ?? ""), String(body.description ?? ""));
      json(response, 202, composite);
    }),
    route("POST", "/api/composites/:compositeId/merge", async (_request, response, params) => {
      await orchestrator.mergeComposite(params.compositeId);
      json(response, 202, { accepted: true });
    }),
    route("POST", "/api/composites/:compositeId/retry", async (_request, response, params) => {
      await orchestrator.retryComposite(params.compositeId);
      json(response, 202, { accepted: true });
    }),
    route("POST", "/api/composites/:compositeId/living", async (_request, response, params) => {
      await orchestrator.setLivingComposite(params.compositeId);
      json(response, 200, { ok: true });
    }),
    route("POST", "/api/pull-requests/sync", async (_request, response) => {
      await orchestrator.syncPullRequests(true);
      json(response, 200, { ok: true });
    }),
    route("PUT", "/api/settings", async (_request, response, _params, body) => {
      const settings = validateSettings(body);
      await store.update((state) => { state.settings = settings; });
      await store.addActivity({ type: "system", message: "Settings updated" });
      events.emit("state", store.get());
      json(response, 200, settings);
    }),
  ];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      for (const candidate of routes) {
        const match = candidate.method === request.method ? url.pathname.match(candidate.pattern) : null;
        if (!match) continue;
        const params = Object.fromEntries(candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
        await candidate.handler(request, response, params, await readJson(request));
        return;
      }
      if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found" });
      const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
      const candidate = join(publicDir, requested === "/" ? "index.html" : requested);
      const safe = candidate.startsWith(publicDir) && existsSync(candidate) && (await stat(candidate)).isFile() ? candidate : join(publicDir, "index.html");
      response.writeHead(200, { "Content-Type": mimeTypes[extname(safe)] ?? "application/octet-stream", "Cache-Control": safe.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
      createReadStream(safe).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: errorMessage(error) });
      else response.end();
    }
  });

  const heartbeat = setInterval(() => events.heartbeat(), 20_000);
  heartbeat.unref();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); resolveListen(); });
  });

  return {
    store, orchestrator, server,
    close: async () => {
      clearInterval(heartbeat);
      await orchestrator.close();
      events.close();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}
