import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const appPath = fileURLToPath(new URL("../src/client/App.tsx", import.meta.url));
const textContent = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map(([, attributes, children]) => ({ label: textContent(children), disabled: /\bdisabled(?:=|\s|$)/.test(attributes) }));
}

function leaf(id, number, overrides = {}) {
  return { id, ideaId: `idea-${id}`, branch: `burner/${id}`, status: "completed", prNumber: number,
    prUrl: `https://github.example.test/fixture/leaf/pull/${number}`, prState: "open", impact: 5, reviewRounds: [], ...overrides };
}

function pendingTerminalLeaf(id, number, kind) {
  const run = leaf(id, number);
  const reason = { kind, continuationId: `continuation-${id}`,
    ...(kind === "withdrawn" ? { head: `head-${id}`, detail: "Replacement selected" } : {}) };
  const fields = { title: id, body: "Retained measurements", isDraft: true, state: "OPEN" };
  return { ...run, leafPr: { terminal: reason, known: { number, url: run.prUrl, fields },
    pending: { id: `close-${id}`, owner: { kind: "terminal-close", reason }, target: { ...fields, state: "CLOSED" } } } };
}

test("real composite views exclude terminal-owned leaves without hiding PR history", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("static client rendering must not call an API"));
  const optimizeDeps = { noDiscovery: true, include: [] };
  const server = await createServer({
    root, configFile: false, appType: "custom", logLevel: "error",
    esbuild: { jsx: "automatic" }, optimizeDeps,
    ssr: { external: ["react", "react-dom"], optimizeDeps },
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    plugins: [{
      name: "withdrawal-test-component-exports", enforce: "pre",
      // Expose the existing functions only in this in-memory SSR module. No
      // component body or eligibility predicate is copied or rewritten.
      transform(code, id) {
        if (id === appPath) return { code: `${code}\nexport { Composites, CompositeDialog };`, map: null };
      },
    }],
  });
  t.after(() => server.close());
  assert.equal(server.httpServer, null, "middleware mode must not create a listening HTTP server");
  assert.deepEqual(server.watcher.getWatched(), {}, "file watching stays disabled");
  const { Composites, CompositeDialog } = await server.ssrLoadModule("/src/client/App.tsx");
  assert.equal(typeof Composites, "function");
  assert.equal(typeof CompositeDialog, "function");

  const normal = leaf("normal", 101), legacy = leaf("legacy", 102, { prState: undefined });
  const excluded = [
    leaf("missing-url", 103, { prUrl: undefined }), leaf("closed", 104, { prState: "closed" }),
    pendingTerminalLeaf("withdrawn", 105, "withdrawn"), pendingTerminalLeaf("superseded", 106, "superseded"),
  ];
  const cases = [
    { name: "two usable sources plus excluded history", runs: [normal, legacy, ...excluded], disabled: false, choices: ["#101 · normal", "#102 · legacy"], history: 6 },
    ...excluded.map((run) => ({ name: `one usable source plus ${run.id}`, runs: [normal, run], disabled: true, choices: ["#101 · normal"], history: 2 })),
    { name: "only excluded sources", runs: excluded, disabled: true, choices: [], history: 4 },
  ];
  const unexpectedAction = () => assert.fail("rendering cannot dispatch or submit work");
  for (const scenario of cases) await t.test(scenario.name, () => {
    const dashboard = { state: { agentRuns: structuredClone(scenario.runs), composites: [], settings: { mergeCadenceMinutes: 60 },
      ideas: scenario.runs.map((run) => ({ id: run.ideaId, title: run.id })) }, runtime: { yolo: false } };
    const before = structuredClone(dashboard);
    const listing = renderToStaticMarkup(createElement(Composites, { dashboard, action: unexpectedAction, onCreate: unexpectedAction }));
    assert.deepEqual(buttons(listing).filter((button) => ["Master cook", "Choose PRs"].includes(button.label)), [
      { label: "Master cook", disabled: scenario.disabled }, { label: "Choose PRs", disabled: scenario.disabled },
    ], "both launch controls use the eligible source count");
    assert.match(textContent(listing), new RegExp(`\\b${scenario.history} leaf PRs\\b`), "excluded sources remain in the historical PR count");

    const dialog = renderToStaticMarkup(createElement(CompositeDialog, { dashboard, onClose: unexpectedAction, onSaved: unexpectedAction, setError: unexpectedAction }));
    assert.equal([...dialog.matchAll(/type="checkbox"/g)].length, scenario.choices.length);
    assert.deepEqual([...dialog.matchAll(/<strong>(#[^<]+)<\/strong>/g)].map((match) => match[1]), scenario.choices,
      "the actual picker exposes only the expected checkbox candidates");
    assert.deepEqual(buttons(dialog).find((button) => button.label === "Cook PRs"), { label: "Cook PRs", disabled: true },
      "available candidates are not silently selected during rendering");
    assert.deepEqual(dashboard, before, "availability rendering preserves the retained history");
  });
});
