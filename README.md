# Burner

Burner is a local control room that continuously improves a repository against the signals you care about. Define evaluations in plain English, score the current repo with `codex exec`, and let an orchestrator turn weak signals into isolated implementation branches and impact-stamped pull requests.

```bash
npm install
npm run build
npm link

cd /path/to/your/repo
burner
# ◉ BURNER → http://127.0.0.1:4321

# Fully autonomous planning, PR creation, and guarded merging:
burner --yolo
```

## What it does

- Runs as a CLI-launched local web server in the target repository. One Burner improves one repository, so several can run at once; each takes the next free port from 4321 unless you pass an explicit `--port`, which never moves.
- Stores repository-owned evaluation definitions in `.burner/evaluations.json`, ready to commit, while keeping run history and machine-local settings in ignored `.burner/state.json`.
- Evaluates arbitrary prompts with structured `codex exec` output.
- Plans cadence-sized improvements from the latest evaluation evidence, decomposing oversized or quarantined scopes before retrying them.
- Runs coding agents in separate git worktrees and branches.
- Limits concurrency globally and uses atomic file locks for scarce resources such as a GPU, simulator, or CPU-heavy test suite.
- Re-runs every evaluation on a candidate branch, computes weighted before/after deltas, and stamps the exact table into the pull request body.
- Runs an independent Codex reviewer against every candidate and resumes the original author session with feedback until the reviewer approves.
- “Master cooks” multiple open PRs into a composite branch, reviews their integration, and recalculates every evaluation from the actual combined code.
- Keeps one approved composite as a living virtual `main`: new ideas are planned from it, experiments branch from its latest commit, and regression-free wins are absorbed back into it.
- Evolves the living line incrementally, so months or years of successful experiments accumulate in one significant feature PR without replaying all history on every iteration.
- Detects merges from Burner or GitHub, fast-forwards the local base, closes source PRs consumed by a composite, and rebuilds other affected composites.
- Ranks completed proposals by measured impact and queued ideas by predicted impact, with one bounded foundational lane for sparse-reward prerequisites.

## Requirements

- Node.js 20.19 or newer
- A git repository with at least one commit
- [Codex CLI](https://developers.openai.com/codex/cli) installed and authenticated
- GitHub CLI (`gh`) authenticated when automatic pull requests are enabled
- A configured git remote (defaults to `origin`)

Burner never sends repository data through its own service. It invokes the locally installed Codex and GitHub CLIs using your existing authentication.

> [!WARNING]
> Burner deliberately launches every Codex agent with `--dangerously-bypass-approvals-and-sandbox`. Authors, revisions, reviewers, planners, prompt evaluators, and composite integrators have unrestricted filesystem and command access as your user—not just access to the target worktree. Use Burner only on repositories and machines where you accept that risk. Burner preflights this capability and fails clearly if the installed Codex CLI does not support it; it never silently falls back to restricted mode.

Meta's wrapped Codex distribution may additionally require its launcher-level `--dangerously-disable-osx-sandbox` flag. Burner detects that unrestricted form during preflight and uses it consistently without a PTY or compatibility shim.

## Usage

```text
Usage: burner [options] [directory]
       burner <command> [subcommand] -C <directory> [options]

Commands:
  eval add       Add an evaluation (--name, --prompt, [--command], [--screening-command], [--weight])
  eval clear     Remove every evaluation (--yes is required)
  eval list      List evaluations and latest scores
  eval run       Run all enabled evaluations and wait for results
  idea add       Queue an idea (--title, --description, [--impact])
  idea list      List improvement ideas
  queue run-next Run exactly one queued idea through review and delivery
  queue retry    Resume a failed candidate (--run)
  pr merge       Merge an open agent PR and synchronize the base (--run)
  settings set   Update automation settings
  status         Print project state and runtime readiness as JSON
```

Run `burner` from the repo you want to improve, configure evaluation prompts in the UI, and run a baseline. “Ignite” starts the continuous loop. Pausing stops new dispatches but lets already-running agents finish safely.

Burner creates `.burner/evaluations.json` and a sibling `.gitignore` that exposes only that file to Git. Commit both files with the repository so fresh checkouts use the same scoring rubric; existing projects copy their definitions into this file automatically. Repositories that already ignore the entire `.burner/` directory may need one initial `git add -f .burner/.gitignore .burner/evaluations.json`. Command-backed evaluations are executable project configuration, so review changes to this file before running them.

The same workflow is scriptable. Commands emit JSON, and `-C` selects the target repository:

```bash
burner eval clear --yes -C ./my-project
burner eval add -C ./my-project --name "Correctness" --prompt "Score correctness and test evidence out of 100"
burner eval add -C ./my-project --name "Benchmark" --prompt "Deterministic benchmark score" --command './bench.sh --json'
burner eval add -C ./my-project --name "Large benchmark" --prompt "Decision-grade benchmark" --command './bench.sh --mode full --json' --screening-command './bench.sh --mode quick --json'
burner settings set -C ./my-project --parallelism 1 --max-review-rounds 12 --portfolio-review-rounds 12 --merge-cadence-minutes 60 --stall-termination-hours 24
burner eval run -C ./my-project
burner idea add -C ./my-project --title "Add crash recovery" --description "Implement and test WAL recovery" --impact 90
burner queue run-next -C ./my-project
# If an external service interrupted a candidate after the author committed:
burner queue retry -C ./my-project --run agent_12345678
```

Configuration, list, and status commands are safe to run while the local Burner
server is active. State updates are serialized across processes and the daemon
loads them on its next scheduler tick, so a scripted `eval add`, `idea add`, or
`settings set` cannot overwrite live agents or disappear behind a later server
write. Commands that would start a second orchestrator (`eval run`, `queue`, and
`pr merge`) instead fail clearly while automation is active; use the local API
or pause the server first.

`queue run-next` is deliberately bounded: it claims the highest-priority queued idea, waits through implementation, the reviewer/author loop, candidate evaluation, and PR delivery, then exits. This makes Burner usable from CI, cron, or a larger local automation script without enabling the continuous timer.

### YOLO portfolio

`burner --yolo` ignites the orchestrator immediately and runs an autonomous PR portfolio. By default Burner retains ten independently authored leaf PRs, then master-cooks those leaves into a composite PR. The composite gets its own integration author, reviewer loop, and complete recalculation from the actual combined checkout. Burner opens the composite as a draft immediately after integration so review progress is visible on GitHub; it marks the PR ready only after approval and complete recalculation.

Use `--yolo-batch-size <n>` to choose a generation size from 1 to 100. A value of `1` opts into the old direct-leaf merge behavior. The default of `10` is intended to produce the long public history of leaf experiments and composite decisions that sustained campaigns need.

Portfolio mode treats the configured merge cadence as a health SLA. The default is 60 minutes. Burner reserves at least the final 10 minutes for composite integration, review, full reevaluation, progress stamping, and merge. Once two healthy reviewed leaves exist, it also uses recent successful end-to-end leaf duration to avoid launching another author cycle that would consume that reserve; failed, interrupted, and quarantined runs never inflate this estimate. If an in-flight leaf remains trapped in review while an approved fallback is waiting, Burner stops before the next expensive review or revision once two reserve phases remain, preserves the unapproved work as a quarantined draft checkpoint, closes that PR so it cannot linger as an orphan, and releases the slot for full fallback validation. An explicit retry reopens the same PR and resumes its author session. With concurrency 1 and no approved fallback, queued replacement work receives a larger half-window reserve so one difficult review loop cannot monopolize the only slot until the deadline is already impossible. Composite and full-leaf tail reserves apply throughout the active cadence window, not only after a formal breach, so late recovery work cannot begin with less time than its complete validation path requires. When the window expires, Burner cooks whatever healthy reviewed subset is available instead of waiting forever for ten leaves; if only one qualifying leaf exists, it may merge that leaf directly. A missed cadence emits a visible error activity and UI warning. Burner never bypasses review, complete evaluation coverage, positive weighted impact, or deterministic no-regression gates for a final merge merely to hit the clock.

A cadence breach is a warning, not an ending: Burner opens a fresh recovery window and keeps working. The stall window is the ending. If the base branch has not set a new best weighted score within `stallTerminationHours` (default 24, `0` disables), Burner pauses the orchestrator, records the plateau in activity, and shuts the process down. Only a strictly better score restarts that clock — a merge that scores flat, a rejected candidate, and a benchmark rejected for contention all leave it running. This is the guard against spending a machine for days re-measuring a plateau after the reachable wins have already been taken.

The cadence also constrains planning. Burner gives the planner an explicit per-leaf wall-clock budget and requires one narrow, independently useful capability with no more than three acceptance outcomes. Evaluation weights and weighted headroom are visible to the planner. When an evaluation is pinned at zero, Burner reserves at most one agent slot for a concrete foundational milestone aimed at the highest-weighted gap; all remaining slots continue incremental work. The lane remains occupied while an approved foundational PR awaits delivery, so a dependent milestone is not planned from an older base. While a foundational leaf is still finishing, portfolio cooking uses available cadence slack before freezing its source set, retaining a two-minute handoff margin ahead of the measured merge tail. Milestone credit affects only scheduling and delivery order, including reserving a composite slot; it never changes measured scores, candidate impact, or merge gates. Umbrella work such as an entire engine, service, persistence layer, UI, or end-to-end product must be decomposed. A failed or quarantined idea is supplied as negative planning evidence and may only return as strictly smaller, non-overlapping increments. Burner owns the canonical merge-coupled README/JSON/SVG progress artifacts, so planners, authors, integrators, revisions, and reviewers are forbidden from creating duplicate history generators, validators, tests, graphs, or update workflows inside the target repository. A code-level boundary rejects those mutations before commit; candidate evaluators are told not to demand a point for the current unmerged PR, and Burner injects that point only after final scores are known. In portfolio mode, a planned generation is stable: Burner does not replenish or re-rank the queue while any planned leaf or composite remains active, so a newly proposed high-impact experiment cannot displace the final small leaf and delay cooking. Reviewers are likewise told to perform a comprehensive blocker pass and report all substantiated merge blockers immediately instead of serializing risk categories across avoidable rounds.

YOLO reviews are bounded independently from manual work. The default portfolio checkpoint is twelve total author/reviewer rounds. The limit is cumulative across resumed loops and read live before every round, so lowering it also constrains work already in flight. A leaf that cannot clear that window is preserved as a visible draft PR with its unresolved findings and `burner-quarantined` label, so substantial work and its author session are not lost. If a composite exhausts the window, Burner maps reviewer file findings back to source branches, labels the strongest-overlap leaf `burner-quarantined`, retires the blocked draft, and repartitions the remaining healthy leaves into balanced recovery composites no larger than half the failed generation.

Each leaf selected for a portfolio generation:

- was approved by the final independent review round;
- has a completed delta for every currently enabled evaluation;
- has no command-backed evaluation regression; and
- was built and evaluated from the current base commit.

Prompt evaluations can be noisy or depend on a sibling change, as progress accounting did before the graph branch was combined. Neither a leaf prompt regression nor a negative leaf aggregate therefore prevents master-cooking. Leaf impact remains visible and is used for ordering, but it is not trusted as an eligibility gate. The actual combined composite is held to the stricter rule: every enabled evaluation must be complete and non-regressing, and weighted impact must be positive, before merge. Every prompt baseline is established as a median of three independent samples before the merge-cadence clock starts. Every nonzero final-gate prompt change—gain or regression—is likewise sampled three times and compared with that authoritative baseline median, so one noisy sample on either side cannot manufacture a change; command-backed changes remain immediate deterministic signals. An evaluation-guided revision must produce a new committed tree before Burner will review or score it again. A no-op revision fails the generation instead of repeatedly resampling identical code until prompt noise happens to pass.

Burner merges at most one change at a time, closes a merged composite's constituent leaf PRs as superseded, synchronizes `main`, and refreshes and median-confirms the full baseline before beginning the next generation. After committing the progress graph to a merge candidate, Burner waits for GitHub to observe that exact head SHA and calculate mergeability, then polls every check on that exact head and refuses failed, errored, cancelled, or timed-out CI. Repositories without CI receive a short grace period for workflows to appear before proceeding. Transient post-push `UNKNOWN`, pending checks, or “not mergeable” responses are retried without rerunning evaluations; real check failures and conflicts fail closed. Reconciliation also retires any completed leaf as soon as its current open PR reports a terminal check failure, even if another leaf or composite was selected first. A hard merge-gate failure retires that exact composite head or quarantines that direct leaf once, records one visible error, and releases eligible fallback work. Burner never retries the unchanged failed head in a tight loop. Other open composites are rebuilt against the new base; unbatched leaves from an obsolete base are closed with an explanation so stale results cannot leak into a later generation. A qualifying portfolio composite becomes the living line: planning and follow-up experiments use its measured branch, and regression-free experiments are absorbed and fully reevaluated before the eventual merge. Failed composites release their leaves instead of reserving them forever.

Burner keeps two mutually exclusive GitHub disposition labels in sync. New/open and closed-without-inclusion PRs carry `burner-unmerged`; directly merged PRs and leaf PRs absorbed through a merged composite carry `burner-merged`. This keeps large portfolio histories readable even though GitHub records absorbed leaves as closed rather than directly merged. Failed composite PRs and cadence-yielded draft leaves are closed immediately; explicit retries reopen the same PR. Composite source leaves remain eligible for a fresh batch or independently validated fallback. On every GitHub synchronization, Burner also closes any open `burner/` PR carrying `burner-unmerged` that is absent from the repository's current `.burner` state, since its review and evaluation provenance can no longer be trusted.

Immediately before every Burner-owned merge, the orchestrator commits three audit artifacts to that PR branch: a managed progress section in `README.md`, `docs/burner-evaluation-progress.svg`, and the complete `docs/burner-evaluation-history.json` source data. The history records the comparable base scores and all enabled candidate scores, keyed by PR so a failed merge retry updates rather than duplicates the point. Baselines are identified by commit, so legacy and current key formats cannot draw duplicate dots for the same repository state. Sparse evaluation lifecycles render as separate line segments across disabled periods, and evaluations introduced after long histories remain visible as singleton markers. Because the artifacts land in the merge candidate itself, GitHub history and the graph advance atomically.

At higher concurrency, a complete leaf batch becomes a drain barrier: Burner stops refilling agent slots, lets in-flight work finish, and then cooks the composite before dispatching more leaves. Deterministic command evaluations remain serialized under the shared `cpu-heavy` and per-command locks. Prompt evaluations use a separate global three-slot pool, so slow repository audits no longer serialize every candidate suite or contend with benchmark ownership. Each prompt evaluator must return within four minutes and is terminated after five, leaving merge-cadence headroom for one targeted retry. Successful scores are retained and only failed evaluations are retried.

Long deterministic evaluations may define a `--screening-command` for YOLO portfolio leaves. Burner first measures that exact screen on the current base, compares every leaf against the comparable screen baseline, and labels those rows in leaf PRs. A rejected infrastructure or unstable-timing run is treated as incomplete rather than numeric zero, preventing a transient bad baseline from manufacturing impact. Correctness and candidate resource-limit failures remain legitimate score-zero regressions. Composite PRs always rerun the full `--command`; cadence-driven single-leaf merges also receive full-command validation before merge. Prompt baselines and every nonzero prompt change at those final gates use independently sampled medians of three. Confirmed baseline medians are persisted and reused until the base commit changes. Command-backed changes remain immediate deterministic signals and are never averaged away.

Every enabled evaluation is a monotonic final-merge gate in YOLO mode. Prompt regressions do not strand otherwise useful leaf branches before they can be combined, but confirmed regressions must be resolved by the fully integrated composite. Composite evaluation regressions are fed back to the integration author, independently reviewed again, and fully rescored for up to three repair passes. Burner will not start another repair pass without a cadence reserve (ten minutes for the default one-hour window). Any failed current-base generation immediately releases its sources and permits a fully validated leaf fallback instead of recooking the same failed batch; healthy batches are still preferred.

An evaluation may optionally provide a local command and a faster, comparable leaf screening command. Burner runs them directly in each evaluated checkout and expects one JSON object on stdout with `score` (0–100), `summary`, `evidence`, and `suggestions`. Command evaluations are useful for deterministic benchmarks and test-derived metrics; they are direct local subprocesses that inherit Burner's permissions and are not `codex exec` invocations, so only configure commands you trust. Evaluations without a command use an unrestricted Codex agent.

## Review and composite workflow

Each implementation author runs in a persistent Codex session. After the author commits a candidate, Burner starts an independent structured reviewer. Requested changes are fed back by resuming the same author session, and the cycle repeats. A merge-eligible PR is opened only after approval and complete branch evaluations. If the review checkpoint is exhausted, Burner instead publishes a clearly marked, non-mergeable draft with the final findings so the work can be resumed rather than disappearing.

The **Master cook** view combines two or more open Burner PRs. Burner creates a worktree from the current base, merges the selected branches, asks an integration author to resolve conflicts and test the result, completes the same review loop, then runs every evaluation on that exact code state. Its composite score is therefore measured directly—not calculated by adding individual scores.

The first composite becomes the **living line**, or you can promote another approved composite from the UI. From then on, planning inspects that branch rather than `main`, and implementation agents start from its latest evaluated commit. Experiments targeting the same line are serialized even when global concurrency is higher. An experiment is absorbed only when its weighted gain clears the configured threshold and no evaluation regresses. Burner then updates the existing composite branch incrementally, reviews the full feature branch again, reruns all evaluations, and updates the same PR. Rejected experiments leave the living line untouched.

This makes the composite behave like a long-running feature program: it can accumulate a year of monotonic, reviewed iteration in one PR while `main` remains unchanged. Burner persists a hidden checkpoint branch after every successful composite update, preserving integration fixes as well as experiment commits. Full reconstruction from that checkpoint is reserved for real base-branch changes or reconciliation after another PR merges.

When a composite merges, Burner closes its included source PRs. It fast-forwards the configured base branch so new agents start from the new main, invalidates the old baseline, and rebuilds every other affected composite after removing PRs that are now merged, closed, or superseded. This reconciliation also runs when a PR is merged from GitHub instead of the Burner dashboard.

## Safety and concurrency

Every `codex exec` invocation uses `--dangerously-bypass-approvals-and-sandbox`, including authors, revision sessions, reviewers, planners, prompt evaluators, and composite integrators. These agents have unrestricted filesystem and command access as your user. Burner also passes `--disable hooks` to these automated invocations, so personal Stop and notification hooks remain available for interactive Codex threads without firing for Burner jobs. Burner still instructs agents not to push or open PRs because the orchestrator owns those state transitions, but that instruction is not a security boundary.

Command-backed evaluations are different: Burner starts their configured command directly as a local subprocess. The Codex flag does not affect them; they already inherit Burner's local permissions.

Stopping Burner aborts active Codex process groups and their descendants and closes all Burner-owned localhost connections before the CLI exits. A clean Ctrl+C therefore does not leave unrestricted authors, reviewers, planners, prompt evaluators, or composite integrators running in the background, and a stalled browser or partial HTTP client cannot wedge shutdown.

Burner also treats the target worktree as the mutation boundary. Author, revision, and composite prompts explicitly forbid edits to parent or sibling repositories, the Burner installation, external tools, and home-directory files. When the target lives inside another Git repository, Burner fingerprints that protected parent (excluding the target itself) before starting and checks it after every Codex invocation. Any drift pauses the orchestrator immediately and leaves the external changes untouched for human inspection; Burner never guesses that it is safe to revert them.

Each idea may declare resource locks. Locks are acquired atomically under `.burner/locks`, in sorted order, and held for the full agent run. If any requested resource is busy, the idea stays queued. Git worktree mutations use a separate short-lived metadata lock.

Concurrency is configurable but defaults to **1**. This favors slower monotonic progress and prevents speculative agents from invalidating one another. Living-line experiments also take a composite-specific lock, so increasing global concurrency never allows two agents to mutate the same lineage simultaneously.

## Development

```bash
npm install
npm run dev       # Build and run the local app on :4321
npm run typecheck
npm test
npm run build
```

## License

MIT
