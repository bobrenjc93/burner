import {
  Activity as ActivityIcon,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  ExternalLink,
  Flame,
  Gauge,
  Github,
  GitPullRequest,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "./components/icons";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type {
  AgentRun,
  BurnerSettings,
  CompositePr,
  DashboardPayload,
  Evaluation,
  EvaluationRun,
  Idea,
} from "../types";
import { api } from "./lib/api";

type Tab = "overview" | "evaluations" | "queue" | "composites" | "settings";

const nav = [
  { id: "overview" as const, label: "Overview", icon: LayoutDashboard },
  { id: "evaluations" as const, label: "Evaluations", icon: Gauge },
  { id: "queue" as const, label: "Improvement queue", icon: Boxes },
  { id: "composites" as const, label: "Master cook", icon: GitPullRequest },
  { id: "settings" as const, label: "Settings", icon: SettingsIcon },
];

export function App() {
  const [dashboard, setDashboard] = useState<DashboardPayload>();
  const [tab, setTab] = useState<Tab>("overview");
  const [sidebar, setSidebar] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [evaluationModal, setEvaluationModal] = useState<Evaluation | "new">();
  const [ideaModal, setIdeaModal] = useState(false);
  const [compositeModal, setCompositeModal] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setDashboard(await api<DashboardPayload>("/dashboard"));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events");
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refresh(), 250);
    };
    ["state", "evaluation", "agent", "composite", "review", "error"].forEach((name) => events.addEventListener(name, scheduleRefresh));
    return () => {
      events.close();
      window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  const action = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setError(undefined);
    try {
      await api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  if (!dashboard) {
    return (
      <div className="boot-screen">
        <Brand />
        <div className="boot-pulse"><Flame size={22} /> Heating the control room…</div>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const running = dashboard.state.orchestrator.enabled;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
        <div className="sidebar-head"><Brand /><button className="icon-btn mobile-only" onClick={() => setSidebar(false)}><X size={18} /></button></div>
        <div className="project-switcher">
          <span className="project-mark">{dashboard.state.projectName.slice(0, 1).toUpperCase()}</span>
          <span><small>Local project</small><strong>{dashboard.state.projectName}</strong></span>
          <ChevronRight size={15} />
        </div>
        <nav>
          <p className="nav-label">Control room</p>
          {nav.map((item) => (
            <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => { setTab(item.id); setSidebar(false); }}>
              <item.icon size={17} /> {item.label}
              {item.id === "queue" && <span className="nav-count">{dashboard.state.ideas.filter((idea) => idea.status === "queued").length}</span>}
              {item.id === "composites" && <span className="nav-count">{dashboard.state.composites.filter((composite) => composite.status === "open").length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {dashboard.runtime.yolo && <div className="health-line"><span className="health-dot warn" /> YOLO auto-merge active</div>}
          <div className="health-line"><span className={dashboard.runtime.codex.available ? "health-dot on" : "health-dot"} /> Codex {dashboard.runtime.codex.available ? "connected" : "missing"}</div>
          <div className="health-line"><span className={dashboard.runtime.gh.authenticated ? "health-dot on" : "health-dot warn"} /> GitHub {dashboard.runtime.gh.authenticated ? "ready" : "not authenticated"}</div>
          <p>Burner stays on this machine.</p>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={() => setSidebar(true)}><Menu size={19} /></button>
          <div className="breadcrumb"><span>Burner</span><ChevronRight size={14} /><strong>{nav.find((item) => item.id === tab)?.label}</strong></div>
          <div className="top-actions">
            {dashboard.runtime.yolo && <span className="yolo-pill"><Zap size={13} /> YOLO auto-merge</span>}
            {dashboard.runtime.runningAgents > 0 && <span className="running-pill"><LoaderCircle size={13} className="spin" /> {dashboard.runtime.runningAgents} agent{dashboard.runtime.runningAgents === 1 ? "" : "s"}</span>}
            <button
              className={running ? "button button-quiet" : "button button-fire"}
              disabled={busy === "orchestrator"}
              onClick={() => void action("orchestrator", running ? "/orchestrator/pause" : "/orchestrator/start")}
            >
              {running ? <Pause size={15} /> : <Flame size={15} />}{running ? "Pause" : "Ignite"}
            </button>
          </div>
        </header>

        <div className="page">
          {dashboard.runtime.yolo && <div className="yolo-banner"><Zap size={17} /><span><strong>YOLO autopilot is active</strong> Burner may autonomously open and merge one current-base PR at a time after reviewer approval, complete evaluation coverage, positive weighted impact, and no deterministic command-evaluation regression.</span></div>}
          <div className="security-banner"><ShieldCheck size={17} /><span><strong>Unrestricted Codex agents</strong> Authors, revisions, reviewers, planners, prompt evaluators, and composite integrators can read and write anywhere and run commands as your user. Command-backed evaluations are separate direct local subprocesses.</span></div>
          {error && <div className="error-banner"><CircleDot size={16} /><span>{error}</span><button onClick={() => setError(undefined)}><X size={15} /></button></div>}
          {tab === "overview" && (
            <Overview dashboard={dashboard} busy={busy} action={action} onAddEvaluation={() => setEvaluationModal("new")} />
          )}
          {tab === "evaluations" && (
            <Evaluations dashboard={dashboard} busy={busy} action={action} onEdit={setEvaluationModal} onAdd={() => setEvaluationModal("new")} refresh={refresh} setError={setError} />
          )}
          {tab === "queue" && (
            <Queue dashboard={dashboard} busy={busy} action={action} onAdd={() => setIdeaModal(true)} />
          )}
          {tab === "composites" && (
            <Composites dashboard={dashboard} busy={busy} action={action} onCreate={() => setCompositeModal(true)} />
          )}
          {tab === "settings" && <Settings dashboard={dashboard} onSaved={refresh} setError={setError} />}
        </div>
      </main>

      {evaluationModal && (
        <EvaluationDialog
          evaluation={evaluationModal === "new" ? undefined : evaluationModal}
          onClose={() => setEvaluationModal(undefined)}
          onSaved={async () => { setEvaluationModal(undefined); await refresh(); }}
          setError={setError}
        />
      )}
      {ideaModal && <IdeaDialog evaluations={dashboard.state.evaluations} onClose={() => setIdeaModal(false)} onSaved={async () => { setIdeaModal(false); await refresh(); }} setError={setError} />}
      {compositeModal && <CompositeDialog dashboard={dashboard} onClose={() => setCompositeModal(false)} onSaved={async () => { setCompositeModal(false); await refresh(); }} setError={setError} />}
    </div>
  );
}

function Brand() {
  return <div className="brand"><span className="brand-flame"><Flame size={18} fill="currentColor" /></span><span>burner</span><em>beta</em></div>;
}

function Overview({ dashboard, busy, action, onAddEvaluation }: {
  dashboard: DashboardPayload;
  busy?: string;
  action: (key: string, path: string, body?: unknown) => Promise<void>;
  onAddEvaluation: () => void;
}) {
  const { state, runtime } = dashboard;
  const latest = latestRuns(state.evaluationRuns);
  const score = dashboard.compositeScore;
  const delta = score !== undefined && dashboard.previousCompositeScore !== undefined ? score - dashboard.previousCompositeScore : undefined;
  const openPrs = state.agentRuns.filter((run) => run.prUrl).length;
  const ranked = [...state.agentRuns].filter((run) => run.status === "completed").sort((a, b) => (b.impact ?? -999) - (a.impact ?? -999)).slice(0, 5);
  const queued = [...state.ideas].filter((idea) => idea.status === "queued").sort((a, b) => b.predictedImpact - a.predictedImpact);
  return (
    <>
      <section className="hero-row">
        <div>
          <div className="eyebrow"><span className={`live-dot ${state.orchestrator.enabled ? "active" : ""}`} /> {state.orchestrator.enabled ? "Furnace running" : "Furnace idle"}</div>
          <h1>Make the repo <span>earn its score.</span></h1>
          <p>Burner watches the signals you define, finds high-leverage work, and measures every branch before it reaches review.</p>
        </div>
        <div className="hero-actions">
          <button className="button button-secondary" disabled={busy === "evaluate" || runtime.runningEvaluations > 0} onClick={() => void action("evaluate", "/evaluations/run")}>
            {runtime.runningEvaluations ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />} Run baseline
          </button>
          <button className="button button-primary" disabled={busy === "plan" || score === undefined} onClick={() => void action("plan", "/orchestrator/plan")}>
            <Sparkles size={16} /> Find improvements
          </button>
        </div>
      </section>

      {!runtime.git.available && <Notice icon={<Github size={19} />} title="Git repository required" body="Initialize this directory and create a first commit before dispatching implementation agents." />}
      {!runtime.codex.available && <Notice icon={<Bot size={19} />} title="Codex CLI not found" body="Install and authenticate Codex, then reload this page to run evaluations." />}

      <section className="metrics-grid">
        <div className="score-card panel">
          <div className="panel-title"><span>Composite score</span><Gauge size={17} /></div>
          <div className="score-main">
            <ScoreRing score={score} />
            <div><strong>{score === undefined ? "No baseline" : score >= 85 ? "Burning bright" : score >= 65 ? "Room to climb" : "Fuel the fire"}</strong><p>Weighted across {state.evaluations.filter((evaluation) => evaluation.enabled).length} active evaluations.</p>{delta !== undefined && <Delta value={delta} />}</div>
          </div>
        </div>
        <Metric icon={<Bot size={18} />} label="Active agents" value={runtime.runningAgents} note={`of ${state.settings.parallelism} slots`} tone="violet" />
        <Metric icon={<GitPullRequest size={18} />} label="Impact-stamped PRs" value={openPrs} note={openPrs ? "ready for review" : "none opened yet"} tone="green" />
        <Metric icon={<LockKeyhole size={18} />} label="Resource locks" value={runtime.heldLocks.length} note={runtime.heldLocks.length ? runtime.heldLocks.join(", ") : "all resources free"} tone="blue" />
      </section>

      <section className="content-grid">
        <div className="panel evaluation-panel">
          <div className="section-head"><div><span className="section-kicker">Signals</span><h2>Evaluation health</h2></div><button className="text-button" onClick={onAddEvaluation}><Plus size={15} /> Add evaluation</button></div>
          {state.evaluations.length ? (
            <div className="eval-list">
              {state.evaluations.slice(0, 6).map((evaluation) => {
                const run = latest.get(evaluation.id);
                const history = state.evaluationRuns.filter((item) => item.evaluationId === evaluation.id && item.status === "completed" && item.context !== "agent").slice(-10);
                return <EvaluationRow key={evaluation.id} evaluation={evaluation} run={run} history={history} />;
              })}
            </div>
          ) : <EmptyState icon={<Gauge />} title="Define your first signal" body="Evaluations turn plain-language goals into trackable scores." action={<button className="button button-primary" onClick={onAddEvaluation}>Add evaluation</button>} />}
        </div>
        <div className="panel activity-panel">
          <div className="section-head"><div><span className="section-kicker">Live</span><h2>Activity</h2></div><ActivityIcon size={17} /></div>
          <div className="timeline">
            {state.activity.slice(0, 8).map((item) => <div className="timeline-item" key={item.id}><span className={`timeline-icon ${item.type}`}><ActivityGlyph type={item.type} /></span><div><strong>{item.message}</strong>{item.detail && <p>{item.detail}</p>}<small>{timeAgo(item.createdAt)}</small></div></div>)}
          </div>
        </div>
      </section>

      <section className="panel impact-panel">
        <div className="section-head"><div><span className="section-kicker">Priority stack</span><h2>Ranked by impact</h2></div><span className="muted-note">Measured wins first, predicted work next</span></div>
        {ranked.length || queued.length ? <div className="impact-table">
          <div className="impact-table-head"><span>Rank</span><span>Improvement</span><span>Status</span><span>Impact</span><span /></div>
          {ranked.map((run, index) => <ImpactRow key={run.id} index={index + 1} run={run} idea={state.ideas.find((idea) => idea.id === run.ideaId)} />)}
          {queued.slice(0, Math.max(0, 5 - ranked.length)).map((idea, index) => <ImpactRow key={idea.id} index={ranked.length + index + 1} idea={idea} />)}
        </div> : <EmptyState icon={<Zap />} title="No improvements ranked yet" body="Run a baseline, then let Burner find its first high-impact move." />}
      </section>
    </>
  );
}

function Evaluations({ dashboard, busy, action, onEdit, onAdd, refresh, setError }: {
  dashboard: DashboardPayload; busy?: string; action: (key: string, path: string, body?: unknown) => Promise<void>;
  onEdit: (evaluation: Evaluation) => void; onAdd: () => void; refresh: () => Promise<void>; setError: (value?: string) => void;
}) {
  const latest = latestRuns(dashboard.state.evaluationRuns);
  const remove = async (evaluation: Evaluation) => {
    if (!window.confirm(`Delete “${evaluation.name}”? Its historical runs will remain in the local state file.`)) return;
    try { await api(`/evaluations/${evaluation.id}`, { method: "DELETE" }); await refresh(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <>
    <PageHeading eyebrow="Your scoring rubric" title="Evaluations" body="Each prompt becomes a calibrated 0–100 signal. Burner uses the evidence and suggested next steps to plan work." actions={<><button className="button button-secondary" disabled={busy === "evaluate"} onClick={() => void action("evaluate", "/evaluations/run")}><RotateCcw size={16} /> Run all</button><button className="button button-primary" onClick={onAdd}><Plus size={16} /> New evaluation</button></>} />
    <div className="evaluation-cards">
      {dashboard.state.evaluations.map((evaluation) => {
        const run = latest.get(evaluation.id);
        const history = dashboard.state.evaluationRuns.filter((item) => item.evaluationId === evaluation.id && item.status === "completed" && item.context !== "agent").slice(-16);
        return <article className={`panel evaluation-card ${evaluation.enabled ? "" : "disabled-card"}`} key={evaluation.id}>
          <div className="evaluation-card-head"><div className="eval-icon"><BarChart3 size={19} /></div><span className="weight-pill">{evaluation.weight}× weight</span><button className="icon-btn" onClick={() => onEdit(evaluation)}><Pencil size={15} /></button><button className="icon-btn danger" onClick={() => void remove(evaluation)}><Trash2 size={15} /></button></div>
          <h3>{evaluation.name}</h3><p className="eval-prompt">{evaluation.prompt}</p>
          <div className="evaluation-card-score"><div><small>Latest score</small><strong>{run?.score?.toFixed(1) ?? "—"}</strong></div><Sparkline values={history.map((item) => item.score ?? 0)} /></div>
          {run?.summary ? <p className="eval-summary">{run.summary}</p> : <p className="eval-summary empty">Run a baseline to collect evidence.</p>}
          <div className="evaluation-card-foot"><span className={evaluation.enabled ? "enabled-label" : "disabled-label"}><span /> {evaluation.enabled ? "Active" : "Paused"}</span><span>{run ? timeAgo(run.createdAt) : "Never run"}</span></div>
        </article>;
      })}
      <button className="add-card" onClick={onAdd}><span><Plus size={21} /></span><strong>Add evaluation</strong><small>Define another signal</small></button>
    </div>
  </>;
}

function Queue({ dashboard, busy, action, onAdd }: { dashboard: DashboardPayload; busy?: string; action: (key: string, path: string, body?: unknown) => Promise<void>; onAdd: () => void }) {
  const columns: { status: Idea["status"][]; label: string; tone: string }[] = [
    { status: ["queued"], label: "Queued", tone: "queued" },
    { status: ["running"], label: "In progress", tone: "running" },
    { status: ["completed"], label: "Completed", tone: "completed" },
    { status: ["failed", "dismissed"], label: "Needs attention", tone: "failed" },
  ];
  return <>
    <PageHeading eyebrow="Autonomous work" title="Improvement queue" body="Ideas are dispatched in predicted-impact order. Resource conflicts stay queued until their locks are free." actions={<><button className="button button-secondary" disabled={busy === "plan"} onClick={() => void action("plan", "/orchestrator/plan")}><Sparkles size={16} /> Generate ideas</button><button className="button button-primary" onClick={onAdd}><Plus size={16} /> Queue manually</button></>} />
    <div className="queue-summary">
      <span><Bot size={16} /> {dashboard.runtime.runningAgents} / {dashboard.state.settings.parallelism} agents working</span>
      <span><LockKeyhole size={16} /> {dashboard.runtime.heldLocks.length ? `Held: ${dashboard.runtime.heldLocks.join(", ")}` : "All shared resources available"}</span>
    </div>
    <div className="kanban">
      {columns.map((column) => {
        const ideas = dashboard.state.ideas.filter((idea) => column.status.includes(idea.status)).sort((a, b) => b.predictedImpact - a.predictedImpact);
        return <section className="kanban-column" key={column.label}><div className="kanban-head"><span className={`status-dot ${column.tone}`} /> <strong>{column.label}</strong><em>{ideas.length}</em></div><div className="kanban-list">
          {ideas.map((idea) => <IdeaCard key={idea.id} idea={idea} run={dashboard.state.agentRuns.find((run) => run.id === idea.agentRunId)} action={action} />)}
          {!ideas.length && <div className="empty-column">Nothing here yet</div>}
        </div></section>;
      })}
    </div>
  </>;
}

function Composites({ dashboard, busy, action, onCreate }: { dashboard: DashboardPayload; busy?: string; action: (key: string, path: string, body?: unknown) => Promise<void>; onCreate: () => void }) {
  const composites = [...dashboard.state.composites].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const eligible = dashboard.state.agentRuns.filter((run) => run.prUrl && (!run.prState || run.prState === "open")).length;
  return <>
    <PageHeading eyebrow="Combined impact" title="Master cook" body="Combine reviewed PRs in a real worktree, review the integration, and recalculate every evaluation against the actual merged code." actions={<><button className="button button-secondary" disabled={busy === "sync"} onClick={() => void action("sync", "/pull-requests/sync")}><RotateCcw size={16} /> Sync GitHub</button><button className="button button-primary" disabled={eligible < 2} onClick={onCreate}><Flame size={16} /> Master cook</button></>} />
    <div className="master-note"><Sparkles size={18} /><div><strong>A living virtual main</strong><p>New experiments branch from the selected living line. Regression-free wins are absorbed, then the entire composite is rebuilt, reviewed, and evaluated again.</p></div></div>
    {composites.length ? <div className="composite-grid">{composites.map((composite) => <CompositeCard key={composite.id} composite={composite} dashboard={dashboard} action={action} busy={busy} />)}</div> : <EmptyState icon={<Flame />} title="Nothing is cooking yet" body="Once two individual Burner PRs are open, combine them into a measured composite." action={<button className="button button-primary" disabled={eligible < 2} onClick={onCreate}>Choose PRs</button>} />}
  </>;
}

function CompositeCard({ composite, dashboard, action, busy }: { composite: CompositePr; dashboard: DashboardPayload; action: (key: string, path: string, body?: unknown) => Promise<void>; busy?: string }) {
  const latestReview = composite.reviewRounds.at(-1);
  const experimentCount = composite.sources.filter((source) => source.kind === "experiment").length;
  const visibleSources = composite.sources.slice(-20);
  const omittedSources = composite.sources.length - visibleSources.length;
  return <article className="panel composite-card">
    <div className="composite-head"><div><span className="section-kicker">{composite.isLiving ? "🔥 Living line" : `${composite.sources.length} constituent changes`}</span><h2>{composite.title}</h2></div><StatusPill status={composite.status} /></div>
    <p className="composite-description">{composite.description}</p>
    <div className="source-prs">{omittedSources > 0 && <span>+{omittedSources} earlier changes</span>}{visibleSources.map((source) => {
      const run = dashboard.state.agentRuns.find((item) => item.id === source.agentRunId);
      return <span key={source.agentRunId} className={source.kind === "pull_request" && run?.prState && run.prState !== "open" ? "source-closed" : ""}>{source.kind === "experiment" ? <Flame size={12} /> : <GitPullRequest size={12} />} {source.prNumber ? `#${source.prNumber}` : source.title} <small>{source.kind === "experiment" ? `${source.impact === undefined ? "" : `+${source.impact.toFixed(1)} · `}absorbed` : run?.prState ?? "open"}</small></span>;
    })}</div>
    <div className="composite-score-row"><div><small>Recalculated composite</small><strong>{composite.compositeScore?.toFixed(1) ?? "—"}<em>/100</em></strong></div><div><small>Absorbed experiments</small><strong>{experimentCount}</strong></div><div><small>Review loop</small><strong className="review-count">{latestReview?.approved ? <><Check size={15} /> Approved</> : composite.reviewRounds.length ? `Round ${composite.reviewRounds.length}` : "Waiting"}</strong></div></div>
    {composite.deltas.length > 0 && <div className="mini-deltas">{composite.deltas.map((delta) => <div key={delta.evaluationId}><span>{delta.name}</span><strong className={(delta.delta ?? 0) >= 0 ? "positive-number" : "negative-number"}>{delta.after?.toFixed(1)} <small>{delta.delta === undefined ? "" : `(${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(1)})`}</small></strong></div>)}</div>}
    {composite.error && <div className="idea-error">{composite.error}</div>}
    <div className="composite-actions"><span>{composite.status === "rebuilding" ? "Absorbing changes and recalculating…" : timeAgo(composite.updatedAt)}</span><div>{!composite.isLiving && composite.status === "open" && <button className="button button-secondary" disabled={busy === `living-${composite.id}`} onClick={() => void action(`living-${composite.id}`, `/composites/${composite.id}/living`)}><Flame size={14} /> Make living</button>}{composite.prUrl && <a className="button button-secondary" href={composite.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> GitHub</a>}{composite.status === "failed" && <button className="button button-secondary" disabled={busy === `retry-${composite.id}`} onClick={() => void action(`retry-${composite.id}`, `/composites/${composite.id}/retry`)}><RotateCcw size={14} /> Retry</button>}{composite.status === "open" && <button className="button button-primary" disabled={busy === `merge-${composite.id}`} onClick={() => { if (window.confirm(`Merge “${composite.title}” and close its source PRs?`)) void action(`merge-${composite.id}`, `/composites/${composite.id}/merge`); }}><GitPullRequest size={14} /> Merge composite</button>}</div></div>
  </article>;
}

function Settings({ dashboard, onSaved, setError }: { dashboard: DashboardPayload; onSaved: () => Promise<void>; setError: (value?: string) => void }) {
  const [form, setForm] = useState<BurnerSettings>(dashboard.state.settings);
  const [saving, setSaving] = useState(false);
  const change = <K extends keyof BurnerSettings>(key: K, value: BurnerSettings[K]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { await api("/settings", { method: "PUT", body: JSON.stringify(form) }); await onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <>
    <PageHeading eyebrow="Furnace controls" title="Settings" body="Tune dispatch, cadence, models, git delivery, and resource contention for this repository." />
    <form className="settings-layout" onSubmit={submit}>
      <div className="settings-main">
        <SettingsSection icon={<Bot size={19} />} title="Agent orchestration" body="Control how much autonomous work Burner can run at once.">
          <div className="form-grid"><Field label="Parallel agents" hint="Defaults to 1 for slow, monotonic progress"><input type="number" min={1} max={12} value={form.parallelism} onChange={(event) => change("parallelism", Number(event.target.value))} /></Field><Field label="Review safety limit" hint="Maximum author/reviewer rounds before stopping"><input type="number" min={1} max={50} value={form.maxReviewRounds} onChange={(event) => change("maxReviewRounds", Number(event.target.value))} /></Field><Field label="Planning interval" hint="Minutes between orchestrator planning passes"><input type="number" min={1} value={form.orchestratorIntervalMinutes} onChange={(event) => change("orchestratorIntervalMinutes", Number(event.target.value))} /></Field><Field label="Evaluation interval" hint="Minutes between repo baseline refreshes"><input type="number" min={1} value={form.evaluationIntervalMinutes} onChange={(event) => change("evaluationIntervalMinutes", Number(event.target.value))} /></Field><Field label="Absorption threshold" hint="Minimum weighted gain required for a living-line experiment"><input type="number" min={0} max={100} step={0.1} value={form.compositeAbsorbThreshold} onChange={(event) => change("compositeAbsorbThreshold", Number(event.target.value))} /></Field><Field label="Default resource locks" hint="Comma-separated; every agent acquires these"><input value={form.defaultResources.join(", ")} placeholder="e.g. gpu, simulator" onChange={(event) => change("defaultResources", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></Field></div>
          <Toggle checked={form.preferLivingComposite} onChange={(value) => change("preferLivingComposite", value)} label="Evolve the living composite" body="Plan and run new experiments from the selected composite instead of main." />
          <Toggle checked={form.autoRun} onChange={(value) => change("autoRun", value)} label="Ignite automatically on launch" body="Resume the continuous loop whenever Burner starts." />
          <p className="settings-hint">Start Burner with <code>burner --yolo</code> to ignite immediately and let the orchestrator merge only reviewed, fully evaluated, monotonic PRs.</p>
        </SettingsSection>
        <SettingsSection icon={<Sparkles size={19} />} title="Codex" body="Leave model fields empty to inherit your local Codex configuration.">
          <div className="form-grid"><Field label="Evaluator model"><input value={form.evaluatorModel} placeholder="Use Codex default" onChange={(event) => change("evaluatorModel", event.target.value)} /></Field><Field label="Implementation model"><input value={form.agentModel} placeholder="Use Codex default" onChange={(event) => change("agentModel", event.target.value)} /></Field></div>
          <div className="security-note"><ShieldCheck size={17} /><span><strong>Unrestricted agent access</strong> Every Codex role bypasses approvals and sandboxing. Agents can access the filesystem and run commands with your user permissions.</span></div>
        </SettingsSection>
        <SettingsSection icon={<Github size={19} />} title="GitHub delivery" body="Burner creates a branch, pushes it, and stamps measured impact into the PR.">
          <div className="form-grid"><Field label="Base branch"><input value={form.baseBranch} onChange={(event) => change("baseBranch", event.target.value)} /></Field><Field label="Git remote"><input value={form.remote} onChange={(event) => change("remote", event.target.value)} /></Field></div>
          <Toggle checked={form.autoCreatePrs} onChange={(value) => change("autoCreatePrs", value)} label="Open pull requests automatically" body="When disabled, completed branches remain local for inspection." />
        </SettingsSection>
      </div>
      <aside className="settings-aside"><div className="panel sticky-save"><h3>Project configuration</h3><p>Saved to <code>.burner/state.json</code> in this repository.</p><div className="readiness"><Readiness ok={dashboard.runtime.codex.available} label="Codex CLI" /><Readiness ok={dashboard.runtime.git.available} label="Git repository" /><Readiness ok={dashboard.runtime.gh.authenticated || !form.autoCreatePrs} label="GitHub auth" /></div><button className="button button-primary full" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Save settings</button></div></aside>
    </form>
  </>;
}

function EvaluationDialog({ evaluation, onClose, onSaved, setError }: { evaluation?: Evaluation; onClose: () => void; onSaved: () => Promise<void>; setError: (value?: string) => void }) {
  const [name, setName] = useState(evaluation?.name ?? "");
  const [prompt, setPrompt] = useState(evaluation?.prompt ?? "");
  const [command, setCommand] = useState(evaluation?.command ?? "");
  const [weight, setWeight] = useState(evaluation?.weight ?? 1);
  const [enabled, setEnabled] = useState(evaluation?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { await api(evaluation ? `/evaluations/${evaluation.id}` : "/evaluations", { method: evaluation ? "PUT" : "POST", body: JSON.stringify({ name, prompt, command: command || undefined, weight, enabled }) }); await onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setSaving(false); }
  };
  return <Modal onClose={onClose}><form onSubmit={submit}><div className="modal-head"><div><span className="section-kicker">Signal design</span><h2>{evaluation ? "Edit evaluation" : "New evaluation"}</h2></div><button type="button" className="icon-btn" onClick={onClose}><X size={18} /></button></div><p className="modal-intro">Write the outcome you care about in plain English. Optionally use a local command for a deterministic score.</p><div className="modal-fields"><Field label="Name"><input autoFocus required value={name} placeholder="e.g. First-run experience" onChange={(event) => setName(event.target.value)} /></Field><Field label="Evaluation prompt" hint="Describe what the score measures, including command-backed signals."><textarea required rows={6} value={prompt} placeholder="Score how quickly a new contributor can understand, install, and successfully run this project out of 100…" onChange={(event) => setPrompt(event.target.value)} /></Field><Field label="Deterministic command (optional)" hint="Runs locally in the evaluated checkout and must print JSON with score, summary, evidence, and suggestions."><textarea rows={3} value={command} placeholder="./scripts/benchmark --json" onChange={(event) => setCommand(event.target.value)} /></Field><div className="form-grid compact"><Field label="Weight" hint="Relative composite-score influence"><input type="number" min={0.1} max={10} step={0.1} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></Field><div className="toggle-field"><Toggle checked={enabled} onChange={setEnabled} label="Active" body="Include in scoring and branch comparisons." /></div></div></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving}>{saving && <LoaderCircle size={15} className="spin" />} {evaluation ? "Save changes" : "Create evaluation"}</button></div></form></Modal>;
}

function IdeaDialog({ evaluations, onClose, onSaved, setError }: { evaluations: Evaluation[]; onClose: () => void; onSaved: () => Promise<void>; setError: (value?: string) => void }) {
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [impact, setImpact] = useState(50); const [resources, setResources] = useState(""); const [selected, setSelected] = useState<string[]>([]); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); try { await api("/ideas", { method: "POST", body: JSON.stringify({ title, description, predictedImpact: impact, evaluationIds: selected, resources: resources.split(",").map((value) => value.trim()).filter(Boolean) }) }); await onSaved(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); setSaving(false); } };
  return <Modal onClose={onClose}><form onSubmit={submit}><div className="modal-head"><div><span className="section-kicker">Manual dispatch</span><h2>Queue an improvement</h2></div><button type="button" className="icon-btn" onClick={onClose}><X size={18} /></button></div><div className="modal-fields"><Field label="Title"><input autoFocus required value={title} placeholder="Improve empty states" onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Implementation brief"><textarea required rows={5} value={description} placeholder="Describe the concrete change and expected outcome…" onChange={(event) => setDescription(event.target.value)} /></Field><div className="form-grid compact"><Field label="Predicted impact"><input type="number" min={0} max={100} value={impact} onChange={(event) => setImpact(Number(event.target.value))} /></Field><Field label="Resource locks" hint="Comma-separated, only when scarce"><input value={resources} placeholder="gpu, ios-simulator" onChange={(event) => setResources(event.target.value)} /></Field></div><Field label="Target evaluations"><div className="check-grid">{evaluations.map((evaluation) => <label className="check-chip" key={evaluation.id}><input type="checkbox" checked={selected.includes(evaluation.id)} onChange={() => setSelected((values) => values.includes(evaluation.id) ? values.filter((id) => id !== evaluation.id) : [...values, evaluation.id])} /><span>{evaluation.name}</span></label>)}</div></Field></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving}>{saving && <LoaderCircle size={15} className="spin" />} Add to queue</button></div></form></Modal>;
}

function CompositeDialog({ dashboard, onClose, onSaved, setError }: { dashboard: DashboardPayload; onClose: () => void; onSaved: () => Promise<void>; setError: (value?: string) => void }) {
  const candidates = dashboard.state.agentRuns.filter((run) => run.prUrl && (!run.prState || run.prState === "open"));
  const [selected, setSelected] = useState<string[]>([]); const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); try { await api("/composites", { method: "POST", body: JSON.stringify({ agentRunIds: selected, title, description }) }); await onSaved(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); setSaving(false); } };
  return <Modal onClose={onClose}><form onSubmit={submit}><div className="modal-head"><div><span className="section-kicker">Composite PR</span><h2>Master cook PRs</h2></div><button type="button" className="icon-btn" onClick={onClose}><X size={18} /></button></div><p className="modal-intro">Select at least two open PRs. Burner will combine their branches—not their scores—then review and evaluate the resulting code.</p><div className="modal-fields"><Field label="Composite title"><input value={title} placeholder="Composite: onboarding and performance" onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Description"><textarea rows={3} value={description} placeholder="Why these changes belong together…" onChange={(event) => setDescription(event.target.value)} /></Field><Field label="Open source PRs"><div className="composite-picker">{candidates.map((run) => { const idea = dashboard.state.ideas.find((item) => item.id === run.ideaId); return <label key={run.id}><input type="checkbox" checked={selected.includes(run.id)} onChange={() => setSelected((values) => values.includes(run.id) ? values.filter((id) => id !== run.id) : [...values, run.id])} /><span><GitPullRequest size={15} /><strong>#{run.prNumber} · {idea?.title ?? run.branch}</strong><small>{run.impact === undefined ? "No impact score" : `${run.impact >= 0 ? "+" : ""}${run.impact.toFixed(1)} individual impact`} · {run.reviewRounds.length} review round{run.reviewRounds.length === 1 ? "" : "s"}</small></span></label>; })}</div></Field></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving || selected.length < 2}>{saving && <LoaderCircle size={15} className="spin" />} Cook {selected.length || ""} PR{selected.length === 1 ? "" : "s"}</button></div></form></Modal>;
}

function Metric({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string | number; note: string; tone: string }) { return <div className="panel metric-card"><span className={`metric-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></div>; }
function Delta({ value }: { value: number }) { const up = value >= 0; return <span className={`delta ${up ? "positive" : "negative"}`}>{up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{up ? "+" : ""}{value.toFixed(1)} since prior baseline</span>; }
function ScoreRing({ score }: { score?: number }) { const value = score ?? 0; return <div className="score-ring" style={{ "--score": `${value * 3.6}deg` } as CSSProperties}><div><strong>{score?.toFixed(1) ?? "—"}</strong><small>/ 100</small></div></div>; }
function Sparkline({ values }: { values: number[] }) { if (values.length < 2) return <div className="sparkline-placeholder" />; const min = Math.min(...values) - 4; const max = Math.max(...values) + 4; const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${38 - ((value - min) / (max - min || 1)) * 34}`).join(" "); return <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none"><defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff7043" stopOpacity=".25" /><stop offset="1" stopColor="#ff7043" stopOpacity="0" /></linearGradient></defs><polygon points={`0,40 ${points} 100,40`} fill="url(#sparkFill)" /><polyline points={points} fill="none" stroke="#ff7043" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>; }
function EvaluationRow({ evaluation, run, history }: { evaluation: Evaluation; run?: EvaluationRun; history: EvaluationRun[] }) { return <div className="eval-row"><div className="eval-score">{run?.score?.toFixed(0) ?? "—"}</div><div className="eval-copy"><strong>{evaluation.name}</strong><p>{run?.summary ?? "Waiting for its first baseline."}</p></div><Sparkline values={history.map((item) => item.score ?? 0)} /><span className="eval-time">{run ? timeAgo(run.createdAt) : "Not run"}</span></div>; }
function ActivityGlyph({ type }: { type: string }) { if (type === "pr") return <GitPullRequest size={13} />; if (type === "agent") return <Bot size={13} />; if (type === "evaluation") return <Gauge size={13} />; if (type === "error") return <X size={13} />; if (type === "idea") return <Sparkles size={13} />; return <Zap size={13} />; }
function ImpactRow({ index, run, idea }: { index: number; run?: AgentRun; idea?: Idea }) { const impact = run?.impact ?? idea?.predictedImpact; return <div className="impact-row"><span className="rank">{String(index).padStart(2, "0")}</span><span className="impact-name"><strong>{idea?.title ?? "Completed improvement"}</strong><small>{run ? "Measured across branch evaluations" : "Predicted impact · awaiting dispatch"}</small></span><span><StatusPill status={run?.status ?? idea?.status ?? "queued"} /></span><span className={`impact-value ${(impact ?? 0) >= 0 ? "up" : "down"}`}>{run && (impact ?? 0) >= 0 ? "+" : ""}{impact?.toFixed(1) ?? "—"}</span><span>{run?.prUrl ? <a className="icon-btn" href={run.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a> : <MoreHorizontal size={17} />}</span></div>; }
function IdeaCard({ idea, run, action }: { idea: Idea; run?: AgentRun; action: (key: string, path: string, body?: unknown) => Promise<void> }) { return <article className="idea-card"><div className="idea-top"><span className="impact-badge"><Zap size={12} /> {idea.predictedImpact.toFixed(0)}</span><span className="idea-source">{idea.source}</span></div><h3>{idea.title}</h3><p>{idea.description}</p>{idea.resources.length > 0 && <div className="lock-chips">{idea.resources.map((resource) => <span key={resource}><LockKeyhole size={11} /> {resource}</span>)}</div>}{run && run.reviewRounds.length > 0 && <div className="review-chip"><ShieldCheck size={12} /> {run.reviewApproved ? `Approved in ${run.reviewRounds.length} round${run.reviewRounds.length === 1 ? "" : "s"}` : `Review round ${run.reviewRounds.length}`}</div>}<div className="idea-foot"><span>{timeAgo(idea.createdAt)}</span>{run?.prUrl ? <a href={run.prUrl} target="_blank" rel="noreferrer"><GitPullRequest size={14} /> PR #{run.prNumber}</a> : idea.status === "failed" || idea.status === "dismissed" ? <button onClick={() => void action(`retry-${idea.id}`, `/ideas/${idea.id}/status`, { status: "queued" })}><RotateCcw size={13} /> Retry</button> : idea.status === "queued" ? <button onClick={() => void action(`dismiss-${idea.id}`, `/ideas/${idea.id}/status`, { status: "dismissed" })}>Dismiss</button> : <span>{run?.status.replace("_", " ")}</span>}</div>{run?.error && <div className="idea-error">{run.error}</div>}</article>; }
function StatusPill({ status }: { status: string }) { return <span className={`status-pill ${status}`}><span />{status.replace("_", " ")}</span>; }
function Notice({ icon, title, body }: { icon: ReactNode; title: string; body: string }) { return <div className="notice">{icon}<div><strong>{title}</strong><p>{body}</p></div></div>; }
function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{body}</p>{action}</div>; }
function PageHeading({ eyebrow, title, body, actions }: { eyebrow: string; title: string; body: string; actions?: ReactNode }) { return <section className="page-heading"><div><span className="section-kicker">{eyebrow}</span><h1>{title}</h1><p>{body}</p></div>{actions && <div className="hero-actions">{actions}</div>}</section>; }
function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) { useEffect(() => { const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]); return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal">{children}</div></div>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Toggle({ checked, onChange, label, body }: { checked: boolean; onChange: (value: boolean) => void; label: string; body: string }) { return <label className="toggle-row"><span><strong>{label}</strong><small>{body}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }
function SettingsSection({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children: ReactNode }) { return <section className="panel settings-section"><div className="settings-section-head"><span>{icon}</span><div><h2>{title}</h2><p>{body}</p></div></div><div className="settings-section-body">{children}</div></section>; }
function Readiness({ ok, label }: { ok: boolean; label: string }) { return <div><span className={`health-dot ${ok ? "on" : "warn"}`} />{label}<em>{ok ? "Ready" : "Check"}</em></div>; }
function latestRuns(runs: EvaluationRun[]) { const latest = new Map<string, EvaluationRun>(); for (const run of runs) { if (run.status !== "completed" || run.context === "agent") continue; const current = latest.get(run.evaluationId); if (!current || current.createdAt < run.createdAt) latest.set(run.evaluationId, run); } return latest; }
function timeAgo(value: string) { const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000); if (seconds < 15) return "just now"; if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }
