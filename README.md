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

- Runs as a CLI-launched local web server in the target repository.
- Stores configuration and run history locally in `.burner/state.json`.
- Evaluates arbitrary prompts with structured `codex exec` output.
- Plans improvements from the latest evaluation evidence.
- Runs coding agents in separate git worktrees and branches.
- Limits concurrency globally and uses atomic file locks for scarce resources such as a GPU, simulator, or CPU-heavy test suite.
- Re-runs every evaluation on a candidate branch, computes weighted before/after deltas, and stamps the exact table into the pull request body.
- Runs an independent Codex reviewer against every candidate and resumes the original author session with feedback until the reviewer approves.
- “Master cooks” multiple open PRs into a composite branch, reviews their integration, and recalculates every evaluation from the actual combined code.
- Keeps one approved composite as a living virtual `main`: new ideas are planned from it, experiments branch from its latest commit, and regression-free wins are absorbed back into it.
- Evolves the living line incrementally, so months or years of successful experiments accumulate in one significant feature PR without replaying all history on every iteration.
- Detects merges from Burner or GitHub, fast-forwards the local base, closes source PRs consumed by a composite, and rebuilds other affected composites.
- Ranks completed proposals by measured impact and queued ideas by predicted impact.

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

The same workflow is scriptable. Commands emit JSON, and `-C` selects the target repository:

```bash
burner eval clear --yes -C ./my-project
burner eval add -C ./my-project --name "Correctness" --prompt "Score correctness and test evidence out of 100"
burner eval add -C ./my-project --name "Benchmark" --prompt "Deterministic benchmark score" --command './bench.sh --json'
burner eval add -C ./my-project --name "Large benchmark" --prompt "Decision-grade benchmark" --command './bench.sh --mode full --json' --screening-command './bench.sh --mode quick --json'
burner settings set -C ./my-project --parallelism 1 --max-review-rounds 8 --portfolio-review-rounds 3 --merge-cadence-minutes 60
burner eval run -C ./my-project
burner idea add -C ./my-project --title "Add crash recovery" --description "Implement and test WAL recovery" --impact 90
burner queue run-next -C ./my-project
# If an external service interrupted a candidate after the author committed:
burner queue retry -C ./my-project --run agent_12345678
```

`queue run-next` is deliberately bounded: it claims the highest-impact queued idea, waits through implementation, the reviewer/author loop, candidate evaluation, and PR delivery, then exits. This makes Burner usable from CI, cron, or a larger local automation script without enabling the continuous timer.

### YOLO portfolio

`burner --yolo` ignites the orchestrator immediately and runs an autonomous PR portfolio. By default Burner retains ten independently authored leaf PRs, then master-cooks those leaves into a composite PR. The composite gets its own integration author, reviewer loop, and complete recalculation from the actual combined checkout. Burner opens the composite as a draft immediately after integration so review progress is visible on GitHub; it marks the PR ready only after approval and complete recalculation.

Use `--yolo-batch-size <n>` to choose a generation size from 1 to 100. A value of `1` opts into the old direct-leaf merge behavior. The default of `10` is intended to produce the long public history of leaf experiments and composite decisions that sustained campaigns need.

Portfolio mode treats the configured merge cadence as a health SLA. The default is 60 minutes. When the window expires, Burner cooks whatever healthy reviewed subset is available instead of waiting forever for ten leaves; if only one qualifying leaf exists, it may merge that leaf directly. A missed cadence emits a visible error activity and UI warning. Burner never bypasses review, complete evaluation coverage, positive weighted impact, or deterministic no-regression gates merely to hit the clock.

YOLO reviews are bounded independently from manual work. The default portfolio budget is three author/reviewer rounds. A leaf that cannot clear that budget is quarantined. If a composite exhausts the budget, Burner maps reviewer file findings back to source branches, labels the strongest-overlap leaf `burner-quarantined`, retires the blocked draft, and immediately recooks the remaining healthy subset. This prevents one experiment from holding unrelated wins hostage.

Each leaf selected for a portfolio generation, and each composite eligible for merging:

- was approved by the final independent review round;
- has a completed delta for every currently enabled evaluation;
- has positive weighted impact above the configured absorption threshold;
- has no command-backed evaluation regression (prompt scores still contribute to weighted impact); and
- was built and evaluated from the current base commit.

Burner merges at most one change at a time, closes a merged composite's constituent leaf PRs as superseded, synchronizes `main`, and refreshes the full baseline before beginning the next generation. Other open composites are rebuilt against the new base; unbatched leaves from an obsolete base are closed with an explanation so stale results cannot leak into a later generation. Failed generations remain inspectable, while review-budget failures are actively split so healthy leaves are released immediately. Portfolio mode deliberately does not promote a living composite, so new leaves continue to be visible PRs from the current `main`.

Burner keeps two mutually exclusive GitHub disposition labels in sync. New/open and closed-without-inclusion PRs carry `burner-unmerged`; directly merged PRs and leaf PRs absorbed through a merged composite carry `burner-merged`. This keeps large portfolio histories readable even though GitHub records absorbed leaves as closed rather than directly merged.

At higher concurrency, a complete leaf batch becomes a drain barrier: Burner stops refilling agent slots, lets in-flight work finish, and then cooks the composite before dispatching more leaves. Short git-metadata operations wait in a lock queue instead of failing agents during simultaneous worktree startup. Evaluation suites are serialized across candidates, acquire the shared `cpu-heavy` resource, and run deterministic command evaluations before parallel prompt evaluations. An evaluating agent that already owns `cpu-heavy` reuses that lease, avoiding lock inversion. This prevents configured benchmarks, benchmark-focused agents, and prompt evaluators' read-only checks from racing another candidate's measurements while unrelated author/reviewer work can still run concurrently.

Long deterministic evaluations may define a `--screening-command` for YOLO portfolio leaves. Burner first measures that exact screen on the current base, compares every leaf against the comparable screen baseline, and labels those rows in leaf PRs. Composite PRs never inherit or extrapolate screen results: they rerun the full `--command` on the actual combined checkout before becoming merge-eligible. The merge-cadence clock starts only after both cold baselines finish, so setup time is reported separately from sustained portfolio throughput.

Prompt evaluations are intentionally treated as noisy signals rather than hard vetoes; a candidate must still have positive weighted impact across all evaluations, while deterministic command-backed regressions always block selection. Integration or evaluation failures remain visible for inspection. Bounded review failures quarantine the implicated leaf and recook the healthy subset; cadence expiry permits a single fully qualified leaf merge only when no two-leaf subset is available. YOLO startup fails unless the root checkout is clean and on the configured base branch, the configured remote exists, Codex supports unrestricted mode, and GitHub CLI authentication is ready. This is distinct from unrestricted Codex execution: Burner always launches Codex without approvals or sandboxing, while `burner --yolo` additionally authorizes GitHub portfolio mutations and merges.

An evaluation may optionally provide a local command and a faster, comparable leaf screening command. Burner runs them directly in each evaluated checkout and expects one JSON object on stdout with `score` (0–100), `summary`, `evidence`, and `suggestions`. Command evaluations are useful for deterministic benchmarks and test-derived metrics; they are direct local subprocesses that inherit Burner's permissions and are not `codex exec` invocations, so only configure commands you trust. Evaluations without a command use an unrestricted Codex agent.

## Review and composite workflow

Each implementation author runs in a persistent Codex session. After the author commits a candidate, Burner starts an independent structured reviewer. Requested changes are fed back by resuming the same author session, and the cycle repeats. A PR is opened only after approval and complete branch evaluations. The configurable review safety limit prevents a pathological loop from consuming resources forever.

The **Master cook** view combines two or more open Burner PRs. Burner creates a worktree from the current base, merges the selected branches, asks an integration author to resolve conflicts and test the result, completes the same review loop, then runs every evaluation on that exact code state. Its composite score is therefore measured directly—not calculated by adding individual scores.

The first composite becomes the **living line**, or you can promote another approved composite from the UI. From then on, planning inspects that branch rather than `main`, and implementation agents start from its latest evaluated commit. Experiments targeting the same line are serialized even when global concurrency is higher. An experiment is absorbed only when its weighted gain clears the configured threshold and no evaluation regresses. Burner then updates the existing composite branch incrementally, reviews the full feature branch again, reruns all evaluations, and updates the same PR. Rejected experiments leave the living line untouched.

This makes the composite behave like a long-running feature program: it can accumulate a year of monotonic, reviewed iteration in one PR while `main` remains unchanged. Burner persists a hidden checkpoint branch after every successful composite update, preserving integration fixes as well as experiment commits. Full reconstruction from that checkpoint is reserved for real base-branch changes or reconciliation after another PR merges.

When a composite merges, Burner closes its included source PRs. It fast-forwards the configured base branch so new agents start from the new main, invalidates the old baseline, and rebuilds every other affected composite after removing PRs that are now merged, closed, or superseded. This reconciliation also runs when a PR is merged from GitHub instead of the Burner dashboard.

## Safety and concurrency

Every `codex exec` invocation uses `--dangerously-bypass-approvals-and-sandbox`, including authors, revision sessions, reviewers, planners, prompt evaluators, and composite integrators. These agents have unrestricted filesystem and command access as your user. Burner still instructs agents not to push or open PRs because the orchestrator owns those state transitions, but that instruction is not a security boundary.

Command-backed evaluations are different: Burner starts their configured command directly as a local subprocess. The Codex flag does not affect them; they already inherit Burner's local permissions.

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
