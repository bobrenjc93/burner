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

Burner defaults to `gpt-6-astra` with `medium` reasoning effort. Every automated Codex role, including resumed author sessions and structured-output fallbacks, receives an explicit model and `-c 'model_reasoning_effort="medium"'`. The evaluator and implementation model fields in Settings can override the model; existing non-empty overrides are preserved, while empty fields use Burner's default rather than your local Codex configuration.

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
  queue retry    Resume a failed or full-score-rejected candidate (--run)
  pr merge       Merge an open agent PR and synchronize the base (--run)
  settings set   Update automation settings
  status         Print project state and runtime readiness as JSON
```

Run `burner` from the repo you want to improve, configure evaluation prompts in the UI, and run a baseline. “Ignite” starts the continuous loop. Pausing stops new dispatches but lets already-running agents finish safely.

For a maintenance restart, use `burner --paused --yolo --no-open ./my-project`. The dashboard starts without dispatching work, even when YOLO or saved auto-run settings normally start it. Inspect recovered state, then resume with Ignite or `POST /api/orchestrator/start`. The flag does not change saved auto-run settings or disable explicit manual API actions; drain active work before stopping the old process.

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

Portfolio mode treats the configured merge cadence as a health SLA. The default is 60 minutes. Burner reserves at least the final 10 minutes for composite integration, review, full reevaluation, progress stamping, and merge. Once two healthy reviewed leaves exist, it also uses recent successful end-to-end leaf duration to avoid launching another author cycle that would consume that reserve; failed, interrupted, and quarantined runs never inflate this estimate. If an in-flight leaf remains trapped in review while an approved fallback is waiting, Burner stops before the next expensive review or revision once two reserve phases remain, preserves the unapproved work as a tracked OPEN draft checkpoint while review capacity remains, and releases the slot for full fallback validation. An explicit retry resumes that same PR and author session; no automatic leaf reopen exists. With concurrency 1 and no approved fallback, queued replacement work receives a larger half-window reserve so one difficult review loop cannot monopolize the only slot until the deadline is already impossible. Composite and full-leaf tail reserves apply throughout the active cadence window, not only after a formal breach, so late recovery work cannot begin with less time than its complete validation path requires. When the window expires, Burner cooks whatever healthy reviewed subset is available instead of waiting forever for ten leaves; if only one qualifying leaf exists, it may merge that leaf directly. A missed cadence emits a visible error activity and UI warning. Burner never bypasses review, complete evaluation coverage, positive weighted impact, or deterministic no-regression gates for a final merge merely to hit the clock.

A cadence breach is a warning, not an ending: Burner opens a fresh recovery window and keeps working. The stall window is the ending. If the base branch has not set a new best weighted score within `stallTerminationHours` (default 24, `0` disables), Burner pauses the orchestrator, records the plateau in activity, and shuts the process down. Only a strictly better score restarts that clock — a merge that scores flat, a rejected candidate, and a benchmark rejected for contention all leave it running. This is the guard against spending a machine for days re-measuring a plateau after the reachable wins have already been taken.

The cadence also constrains planning. Burner gives the planner an explicit per-leaf wall-clock budget and requires one narrow, independently useful capability with no more than three acceptance outcomes. Evaluation weights and weighted headroom are visible to the planner. Burner reserves at most one agent slot for a concrete foundational milestone aimed at the largest measured, unrounded weighted gap among enabled evaluations below 100; all remaining slots continue incremental work. This sequence continues after the first nonzero score, while unmeasured or saturated evaluations do not claim the slot. The lane remains occupied while an approved foundational PR awaits delivery, so a dependent milestone is not planned from an older base. While a foundational leaf is still finishing, portfolio cooking uses available cadence slack before freezing its source set, retaining a two-minute handoff margin ahead of the measured merge tail. Milestone credit affects only scheduling and delivery order, including reserving a composite slot; it never changes measured scores, candidate impact, or merge gates. Umbrella work such as an entire engine, service, persistence layer, UI, or end-to-end product must be decomposed. A failed or quarantined idea is supplied as negative planning evidence and may only return as strictly smaller, non-overlapping increments. Burner owns the canonical merge-coupled README/JSON/SVG progress artifacts, so planners, authors, integrators, revisions, and reviewers are forbidden from creating duplicate history generators, validators, tests, graphs, or update workflows inside the target repository. A code-level boundary rejects those mutations before commit; candidate evaluators are told not to demand a point for the current unmerged PR, and Burner injects that point only after final scores are known. In portfolio mode, a planned generation is stable: Burner does not replenish or re-rank the queue while any planned leaf or composite remains active, so a newly proposed high-impact experiment cannot displace the final small leaf and delay cooking. Reviewers are likewise told to perform a comprehensive blocker pass and report all substantiated merge blockers immediately instead of serializing risk categories across avoidable rounds.

YOLO reviews are bounded independently from manual work. The default portfolio checkpoint is twelve total author/reviewer rounds. The limit is cumulative across resumed loops and read live before every round, so lowering it also constrains work already in flight. A leaf with an unresolved need for another round but no remaining capacity is retained with its findings and author session, then closed only through its exact owned terminal receipt. Interrupted delivery of an approved last round remains resumable. If a composite exhausts the window, Burner maps reviewer file findings back to source branches, labels the strongest-overlap leaf `burner-quarantined`, retires the blocked composite draft, and repartitions the remaining healthy leaves into balanced recovery composites no larger than half the failed generation.

Manual `POST /api/ideas` requests can use the same reserved lane with `lane: "foundational"`, a nonempty `milestone` (at most 1,000 characters), and optional numeric `milestoneCredit` from 0 to 100. The default remains incremental with no milestone credit. Invalid lane or milestone fields are rejected before queueing. At most one foundational slot is reserved, whether ideas came from the planner or the API; credit never alters evaluation scores or merge gates.

Evidence workers and leaf reviewers receive the original task requirements; composite evidence workers receive only the currently included sources and integration requirements. The post-commit evidence step refreshes stale current-candidate reports and produces explicitly required first captures, even if no report was checked in during implementation. It does not invent new measurement scope, and development-only dirty-source runs do not satisfy required clean-commit captures. Reviewers also receive the unverified evidence handoff. Current-candidate measurements require current, clean provenance; explicitly historical workload records retain their original source/build identities. Missing historical setup costs may be supplied by a clearly labeled, verified same-code rerun without rewriting original compute measurements. Historical records never substitute for fresh evidence required by the current task or earn current-candidate performance credit.

Each leaf selected for a portfolio generation:

- was approved by the final independent review round;
- has a completed delta for every currently enabled evaluation;
- has no command-backed evaluation regression; and
- was built and evaluated from the current base commit.

Prompt evaluations can be noisy or depend on a sibling change, as progress accounting did before the graph branch was combined. Neither a leaf prompt regression nor a negative leaf aggregate therefore prevents master-cooking. Leaf impact remains visible and is used for ordering, but it is not trusted as an eligibility gate. The actual combined composite is held to the stricter rule: every enabled evaluation must be complete and non-regressing, and weighted impact must be positive, before merge. Every prompt baseline is established as a median of three independent samples before the merge-cadence clock starts. Every nonzero final-gate prompt change—gain or regression—is likewise sampled three times and compared with that authoritative baseline median, so one noisy sample on either side cannot manufacture a change; command-backed changes remain immediate deterministic signals. An evaluation-guided revision must produce a new committed tree before Burner will review or score it again. A no-op revision fails the generation instead of repeatedly resampling identical code until prompt noise happens to pass.

Burner merges at most one change at a time, verifies exact source inclusion before closing a merged composite's leaf PRs as superseded, synchronizes `main`, and refreshes and median-confirms the full baseline before beginning the next generation. After committing the progress graph to a merge candidate, Burner waits for GitHub to observe that exact head SHA and calculate mergeability, then polls every check on that exact head and refuses failed, errored, cancelled, or timed-out CI. Repositories without CI receive a short grace period for workflows to appear before proceeding. Transient post-push `UNKNOWN`, pending checks, or “not mergeable” responses are retried without rerunning evaluations; every actual leaf merge request repeats complete preflight against the fresh remote base. Real check failures and conflicts fail closed. Reconciliation quarantines the exact owned leaf as a tracked draft while genuine repair capacity remains; exhausted or explicitly abandoned leaves close through their checked terminal owner. Unknown remote states are preserved and reported. A hard merge-gate failure retires that exact composite head or quarantines that direct leaf once, records one visible error, and releases eligible fallback work. Burner never retries the unchanged failed head in a tight loop. Other open composites are rebuilt against the new base; reviewed obsolete leaves require same-PR refresh. A qualifying portfolio composite becomes the living line: planning and follow-up experiments use its measured branch, and regression-free experiments are absorbed and fully reevaluated before the eventual merge. Failed composites release their leaves instead of reserving them forever.

Pending CI gets up to 360 check polls, 2.5 seconds apart: about 15 minutes of polling delay, plus GitHub request time. Expiring that budget is retryable; it does not waive required checks or retire the candidate as a failed implementation. Terminal check failures still block immediately.

Labels and branch-list results are presentation/discovery hints, not leaf ownership or landing evidence. Apparent orphan `burner/` PRs absent from retained state are reported without being edited, adopted, reopened, or closed. Owned OPEN/terminal-pending leaves retain their run, idea, continuation, and transitive evidence closure together. Absorption into a living composite is a checked transfer, not proof of a merge. Landing requires the saved source head to be an ancestor of the associated PR merge commit and that commit to be an ancestor of the fresh stable remote base. Squash/rebase landings without that proof remain unresolved; whole-tree equality is reserved for separate baseline-score reuse.

Immediately before every Burner-owned merge, the orchestrator commits three audit artifacts to that PR branch: a managed progress section in `README.md`, `docs/burner-evaluation-progress.svg`, and the complete `docs/burner-evaluation-history.json` source data. The history records the comparable base scores and all enabled candidate scores, keyed by PR so a failed merge retry updates rather than duplicates the point. Baselines are identified by commit, so legacy and current key formats cannot draw duplicate dots for the same repository state. Sparse evaluation lifecycles render as separate line segments across disabled periods, and evaluations introduced after long histories remain visible as singleton markers. Because the artifacts land in the merge candidate itself, GitHub history and the graph advance atomically.

At higher concurrency, a complete leaf batch becomes a drain barrier: Burner stops refilling agent slots, lets in-flight work finish, and then cooks the composite before dispatching more leaves. Deterministic command evaluations remain serialized under the shared `cpu-heavy` and per-command locks. Prompt evaluations use a separate global three-slot pool, so slow repository audits no longer serialize every candidate suite or contend with benchmark ownership. Each prompt evaluator must return within four minutes and is terminated after five, leaving merge-cadence headroom for one targeted retry. Successful scores are retained and only failed evaluations are retried.

When a normal YOLO tick finds the scheduler idle and the current-base baseline complete, an already queued or rebuilding composite takes priority over standalone leaf validation or cooking another batch. An already qualified composite retains merge priority. Automatic same-PR base refreshes also respect composite source reservations, so they do not independently rewrite a source branch during integration. Paused scheduling, active work, and explicit manual cycles retain their existing behavior; integration still goes through the normal review, evaluation, and merge gates.

Reviewed PRs already waiting for a same-PR refresh survive further base advances. Burner keeps their branches, author sessions, review history, and historical full assessments; old-base assessments no longer qualify the new comparison. The refreshed code must still pass review and evaluation again. If initial implementation was interrupted, base refresh carries that unfinished task forward instead of treating the base merge as author completion.

Long deterministic evaluations may define a `--screening-command` for YOLO portfolio leaves. Burner first measures that exact screen on the current base, compares every leaf against the comparable screen baseline, and labels those rows in leaf PRs. A rejected infrastructure or unstable-timing run is treated as incomplete rather than numeric zero, preventing a transient bad baseline from manufacturing impact. Correctness and candidate resource-limit failures remain legitimate score-zero regressions. Composite PRs always rerun the full `--command`; cadence-driven single-leaf merges also receive full-command validation before merge. Prompt baselines and every nonzero prompt change at those final gates use independently sampled medians of three. Confirmed baseline medians are persisted and reused until the base commit changes. Command-backed changes remain immediate deterministic signals and are never averaged away.

Every enabled evaluation is a monotonic final-merge gate in YOLO mode. Prompt regressions do not strand otherwise useful leaf branches before they can be combined, but confirmed regressions must be resolved by the fully integrated composite. Composite evaluation regressions are fed back to the integration author, independently reviewed again, and fully rescored for up to three repair passes. Burner will not start another repair pass without a cadence reserve (ten minutes for the default one-hour window). Any failed current-base generation immediately releases its sources and permits a fully validated leaf fallback instead of recooking the same failed batch; healthy batches are still preferred.

An evaluation may optionally provide a local command and a faster, comparable leaf screening command. Burner runs them directly in each evaluated checkout and expects one JSON object on stdout with `score` (0–100), `summary`, `evidence`, and `suggestions`. Command evaluations are useful for deterministic benchmarks and test-derived metrics; they are direct local subprocesses that inherit Burner's permissions and are not `codex exec` invocations, so only configure commands you trust. Evaluations without a command use an unrestricted Codex agent.

### Command evidence retention

Every orchestrated command evaluation attempts to retain its raw output in the canonical repository's `.burner/evaluation-runs/<evaluation-run-id>/`, outside the evaluated worktree. Capture finishes before the result is persisted as completed or failed. The archive includes measured commit, evaluation-definition version, context, source checkout and timestamps; `stdout.txt`, `stderr.txt`, exit/termination metadata in `command.json`, and a separate `normalized.json` when normalization succeeds. Thus the original score precision remains inspectable without changing Burner's one-decimal stored scores. Invalid JSON, invalid or inconclusive measurements, command failures and shutdown/timeouts are captured too. Stderr contains the process output before Burner's synthetic termination message; the termination reason is recorded separately.

Commands receive `BURNER_EVALUATION_ARTIFACT_DIR`, a fresh temporary export directory. To retain detailed reports, explicitly **copy** each required file into that directory before exiting, including on failure. Use a flat set of at most 128 regular files, each at most 32 MiB and totaling at most 128 MiB. Names must be 1–128 ASCII letters, digits, dots, underscores or hyphens, beginning with a letter or digit. Directories, symlinks, hard links and special files are rejected. Finish writing and close all files before the command exits; do not leave background writers. Burner copies accepted files into `artifacts/` and removes its temporary export directory only after collection succeeds. On incomplete collection it preserves the owned sink and records its absolute `recoveryDirectory` in the run reference and manifest, so a read/copy/disk error does not delete the only complete producer file. That recovery directory may include rejected or unfinished files: it is not a validated archive and is not subject to the archive's byte limits. Collection errors and partial copies are explicit. These checks bound collection, not what an unrestricted command can write while it runs.

Export every raw file needed to interpret a report and use matching relative links between the exported files. Burner does not parse paths from `evidence` strings, follow report references, discover files in `target/`, or copy directories. Existing producers that do not export files still have their stdout/stderr retained; a report path printed on stdout does not retain that report. For example, a producer can copy `report.json` and its referenced `samples.json.gz` into the supplied directory without changing its score-producing JSON contract. Raw observations from a deleted historical worktree cannot be reconstructed or relabeled by a later rerun.

The sealed `manifest.json` lists retained files with sizes, SHA-256 hashes and completeness, alongside any retention errors. `EvaluationRun.commandEvidence` points to this original measurement and reports `capturing`, `complete` or `incomplete`; promoting a score to a baseline preserves that original reference. Each decoded stdout/stderr stream retains only its first 8 MiB after UTF-8 re-encoding (a byte cutoff can split a multibyte character); truncation is explicit. This bounds archive retention, not the existing command-output buffer used to parse the result. Abrupt termination of Burner itself can leave an unsealed, incomplete archive; the running reference already records the owned export sink for recovery. Normal command failure and orderly shutdown finalize the available data. Retention failures are reported separately and never invent a score, replace a command error, change qualification policy or overwrite an earlier attempt. Publication seals the manifest; a failed removal of its temporary hard link may leave a second filename but does not invalidate the published evidence.

Runtime archives remain Git-ignored and survive worktree removal and state-history trimming. Repository-local retention is not Git publication: check in selected immutable evidence only through a deliberate reviewed repository change. Burner does not automatically delete old archives or manage disk quotas, so operators must account for accumulated disk usage. Raw command output and explicitly exported files may contain sensitive information; archive directories and files are created with owner-only permissions, and whole settings, environment and state dumps are not added by Burner.

Baseline calibration is not a score floor. Prompt evaluators must first check that the evidence measures the rubric's actual API, backend, workload scope, and denominator. Concrete evidence of a wrong comparison or benchmark-specific shortcut must set `baselineInvalid: true`, even when the defect predates the candidate. Burner rejects that result instead of accepting a calibrated score: correct and version the evaluator in a separate reviewed change, then measure a fresh baseline. Do not count the correction as an implementation gain or regression. Command results may also provide this boolean; ordinary four-field command output remains supported. Full merge-validation caches are bound to the validity protocol and evaluation-definition versions.

Fresh baseline evaluations apply the current rubric independently of historical numeric scores, including when repository prompts still ask to preserve old calibration. They may record lower current scores and explain the historical correction without changing the rubric or rewriting old history. A wrong historical score alone does not invalidate the fresh measurement; an invalid current measurement contract still fails closed. Candidate evaluations use the supplied current-base measurement, not older graph points, and still reject an invalid supplied baseline.

## Review and composite workflow

Each implementation author runs in a persistent Codex session. After Burner commits the author's candidate, it starts an independent structured reviewer. Requested changes are fed back by resuming the same author session, and the cycle repeats. A merge-eligible PR is opened only after approval and complete branch evaluations. A review checkpoint retains the final findings in a clearly marked, non-mergeable draft. A tracked OPEN checkpoint with review capacity may resume; an exhausted checkpoint reaches checked terminal closure and is not retryable.

The **Master cook** view combines two or more open Burner PRs. Burner creates a worktree from the current base, merges the selected branches, asks an integration author to resolve conflicts and test the result, completes the same review loop, then runs every evaluation on that exact code state. Its composite score is therefore measured directly—not calculated by adding individual scores.

An authorized manual or automatic leaf merge owns readiness only after the exact independent approval and configured evaluation gates pass. It then rechecks the complete PR tuple, CI, source head, and fresh remote base before each actual merge request. Ordinary and separate-full sampling policies remain distinct; merge itself never samples. A changed head, content, lifecycle, or base prevents the merge.

Manual leaf merging also requires exact independent approval and a completed, authoritative evaluation receipt; presentation deltas alone are not evidence. It consumes existing qualification without starting evaluations. Each new leaf records its ordinary or separate-full policy, so a default CLI/server restart cannot weaken a portfolio/fallback leaf's full gate. Ordinary nonscreened delivery remains sufficient for a recorded ordinary leaf. Unknown legacy origin is not ordinary: exact full qualification provides its merge route without inventing an origin or increasing its review allowance. Known origins use their corresponding configured review limit; unknown origins use the lower configured limit, always counting all prior rounds. A saved negative full verdict continues to block an evaluation-repair replacement even after its head changes: only a later valid full qualification supersedes that requirement. Missing, incomplete, or changed evidence stops merge without a force/bypass option.

Same-branch resume retries reuse the existing worktree after verifying its repository and branch. Staged and unstaged edits, untracked files, and ignored build or measurement output are preserved. An unfinished author can resume its session; unexpected edits after a completed step stop recovery rather than being silently committed. An unexpected directory, repository, branch, file, or symlink stops the retry without deleting it. Unretained missing worktrees may be recreated from the saved branch; a failed Git identity check is not proof that a directory is absent.

For an existing numbered leaf PR, the public retry, base-refresh and full-qualification options accept `retainWorktree: true`. HTTP retry/rebase accept the same literal option, and `queue retry --retain-worktree` forwards it. Burner establishes exact PR ownership first (including any required legacy proof), then durably latches `run.retainWorktree` before work or cleanup. The latch survives omitted options, restart, failure, cancellation and terminal settlement; selected leaf cleanup leaves the registered checkout and all its files in place. There is no `false` release option or private archive/copy hook. Initial admission can allocate an actually absent deterministic checkout. After the latch is saved, a restart can discover an extant exact author/full checkout, but missing or ambiguous allocation, dual paths, or identity drift require explicit reconciliation instead of silent creation or deletion. Other runs retain their usual cleanup behavior.

An explicit retry can also repair an independently approved leaf rejected by the full evaluation gate while review capacity remains, without closing its PR or synchronizing unrelated PRs. Full score rejection remains evaluation evidence, not an execution failure; a rejected leaf needing an unavailable review round instead reaches checked terminal closure. Burner verifies the current base, evaluation definitions, clean rejected head, and matching open remote PR before admitting the repair. Append-only `fullEvaluationHistory` retains each assessment's confirmed deltas, impact, exact rejected tree, and comparison provenance. The old `fullMergeValidation` field is read-only compatibility input until that target's exact evidence is adopted; new-format writes have no mutable latest alias. `latestFullAssessment` is the canonical readout and `fullAssessmentForIdentity` resolves exact feedback/publication/qualification. `POST /api/agents/:runId/retry` accepts optional `repairNotes` (at most 12,000 characters), and `queue retry` accepts `--repair-notes`; notes are guidance, not evaluation evidence. The existing branch, PR, session and cumulative review budget are retained. Every applicable historical rejection remains a guard: returning A after rejecting A and B cannot buy another review or score sample, even if a newer positive assessment exists. Changed implementation or legitimate new-base comparisons remain available; full qualification and merge remain separate actions.

Initial execution and retry use one durable `continuation` cursor: author, commit receipt, evidence, review, delivery, then done. A completed model result and staged Git tree are saved before finalization; restart recognizes the exact resulting commit or finalizes the saved tree without invoking that model again. Consumed review responses and completed evidence handoffs are not repeated. Done preserves the existing no-change, no-PR, absorbed and rejected outcomes as well as normal PR delivery.

If delivery fails after approval, retry can finish delivery of that exact clean head without another author, evidence refresh, or review round—even when the last available round approved it. This requires a complete approval checkpoint and unchanged base/evaluation identity. Delivery and full qualification independently retain each completed seed and confirmation, the frozen comparison sources, and the exact reduction; a sibling or publication failure does not repeat successful samples. Raw samples are not relabeled as medians. A completed full verdict and an unfinished PR-body edit are separate saved facts, so recovery finishes or observes the edit without rescoring. Worktree cleanup is best-effort after terminal results are saved; unexpected dirty files and unfinished full-evaluation checkouts are retained.

Completed receipts are verified using their recorded evaluation definitions, weights and threshold, not today's settings. A later policy edit does not rewrite a historical verdict, hide an observed merge, or invalidate an exact already-applied publication acknowledgment. Finishing a recorded full result or its factual publication is not current qualification. New samples, repair/review work, readiness, merge, composite consumption and baseline promotion still require their applicable current-policy checks. An unchanged completed candidate cannot buy another assessment merely by changing policy; stale pending readiness or weight-presentation requests stop before an unapplied effect, while exact after-images can be acknowledged without granting new authority.

Progress stamping and latest-base refresh are named continuation steps. Their deterministic managed-file plans, exact commit parents/trees, and saved remote-head leases let retry recognize already completed writes, commits, and pushes. Verified progress-certificate chains normalize only their generated transformations against the same recorded base; authored README or other documentation changes are not discarded. Base refresh first consumes prepared author/evidence receipts. If full sampling is incomplete and the intended base legitimately advances, one atomic transition retains that partial receipt as superseded, clears its active owner, and installs the pinned refresh. A completed reduction is instead finalized with its recorded verdict/time and its old-head publication reconciled before refresh; it is never rerolled or mislabeled partial. Full qualification reuses the recorded clean checkout or durably binds its recreated full-owner checkout, which refresh can then resume. A later base advance requires another explicit refresh. These steps preserve the same author, PR, history, and cumulative budget. Retrying them does not authorize merge.

Explicit retries do not start queued work while orchestration is paused. `queue retry` uses manual initialization, preserving `autoRun` while installing no scheduler/PR-sync timer. Its existing headless preflight still refuses active work, including queued composites. Other CLI commands retain their initialization behavior. A cadence or review-budget checkpoint can recover a push interrupted before its receipt only at the saved prior PR head or exact saved cursor head. Closed leaves are not automatically reopened.

Burner saves the author session ID as soon as Codex announces it, including during initial implementation and composite integration. If the initial author is interrupted, retry resumes that same session with the original task before starting review; an interrupted review resumes the existing review workflow. Neither recovery path skips review or evaluation gates. A session ID alone is not proof of successful author completion. Legacy version-3 checkpoints are admitted only for the requested run when completion and feedback provenance can be established; ambiguous author results, approval identities or old full-score summaries stop without new samples. Retained continuation and PR owners protect their owning ideas, measurement rows, and historical comparison baselines from rolling state-history trimming.

Leaf content and lifecycle use one durable `leafPr` owner: exact repository/branch/base identity, last acknowledged complete title/body/draft/state tuple, and one immutable pending intent. Title and body are separate single-field effects; each effect must observe its exact before- or after-image. A third state stops without overwriting it. Creation saves a unique body marker before an exhaustive all-state branch search; unknown or competing matches are not adopted. Completed evaluation evidence and unfinished presentation remain separate facts.

Known-number legacy PRs require optional `legacyPrProof` on the existing retry, base-refresh, or full-qualification entry point; CLI retry accepts `--legacy-pr-proof <json-file>`. Its exact object is `{ "protocol": "executed-leaf-writer-v1", "directory": "/absolute/retained/archive", "startedSha256": "…", "resultSha256": "…", "stateSha256": "…" }`. The read-only validator recognizes independently pinned executed writer/runtime bytes, checks the retained target and operation sequence, and reconstructs one historical OPEN/draft tuple before targeted atomic adoption. It does not execute archived code, accept arbitrary observed fields, migrate all state, or treat repair notes as proof. Missing or unsupported evidence refuses admission.

The PR protocol assumes cooperative single-orchestrator use. GitHub provides no content/base compare-and-swap guarantee here: changes observed between requests are rejected, but invisible external ABA changes cannot be excluded. Successful-but-uncertain merge responses require exact graph settlement; MERGED is never fabricated into an acknowledgment of close or readiness.

The integration author also receives the composite description and confirmed source-evaluation regressions, including evidence and repair suggestions. Feedback must match the reviewed source commit, current rubric, and comparable baseline; prompt feedback requires three independent samples. These are repair leads to verify against the combined code, not substitutes for its independent review or final evaluations.

Before each leaf or composite review, Burner resumes its author for a bounded post-commit evidence step. The implementation must already be clean and committed. The author refreshes only stale candidate measurements using existing repository tooling, leaving implementation, harnesses, scoring, and historical baseline evidence unchanged; candidates with no stale evidence need no edits. Burner commits regenerated reports and accompanying documentation separately, then performs the normal complete review and evaluations. This also runs after review fixes and evaluation-guided repairs, so a code change need not consume another review round merely to obtain a clean commit for measurements. Evidence provenance remains a merge requirement, not a waived check.

The first composite becomes the **living line**, or you can promote another approved composite from the UI. From then on, planning inspects that branch rather than `main`, and implementation agents start from its latest evaluated commit. Experiments targeting the same line are serialized even when global concurrency is higher. An experiment is absorbed only when its weighted gain clears the configured threshold and no evaluation regresses. Burner then updates the existing composite branch incrementally, reviews the full feature branch again, reruns all evaluations, and updates the same PR. Rejected experiments leave the living line untouched.

This makes the composite behave like a long-running feature program: it can accumulate a year of monotonic, reviewed iteration in one PR while `main` remains unchanged. Burner persists a hidden checkpoint branch after every successful composite update, preserving integration fixes as well as experiment commits. Full reconstruction from that checkpoint is reserved for real base-branch changes or reconciliation after another PR merges.

When a composite merges, Burner closes its included source PRs. It fast-forwards the configured base branch so new agents start from the new main, invalidates the old baseline, and rebuilds every other affected composite after removing PRs that are now merged, closed, or superseded. This reconciliation also runs when a PR is merged from GitHub instead of the Burner dashboard.

## Safety and concurrency

Every `codex exec` invocation uses `--dangerously-bypass-approvals-and-sandbox`, including authors, revision sessions, reviewers, planners, prompt evaluators, and composite integrators. These agents have unrestricted filesystem and command access as your user. Burner also passes `--disable hooks` to these automated invocations, so personal Stop and notification hooks remain available for interactive Codex threads without firing for Burner jobs. Burner still instructs agents not to push or open PRs because the orchestrator owns those state transitions, but that instruction is not a security boundary.

Command-backed evaluations are different: Burner starts their configured command directly as a local subprocess. The Codex flag does not affect them; they already inherit Burner's local permissions.

Stopping Burner aborts active Codex process groups and their descendants and closes all Burner-owned localhost connections before the CLI exits. A clean Ctrl+C therefore does not leave unrestricted authors, reviewers, planners, prompt evaluators, or composite integrators running in the background, and a stalled browser or partial HTTP client cannot wedge shutdown.

Burner also treats the target worktree as the mutation boundary. Author, revision, and composite prompts explicitly forbid edits to parent or sibling repositories, the Burner installation, external tools, and home-directory files. When the target lives inside another Git repository, Burner fingerprints that protected parent (excluding the target itself) before starting and checks it after every Codex invocation. Any drift pauses the orchestrator immediately and leaves the external changes untouched for human inspection; Burner never guesses that it is safe to revert them.

Each idea may declare resource locks. Locks are acquired atomically under `.burner/locks`, in sorted order, and held for the full agent run. If any requested resource is busy, the idea stays queued. Scheduling scans past blocked ideas to fill free incremental slots with runnable lower-priority work; a pending foundational idea keeps its reserved slot even while blocked. Git worktree mutations use a separate short-lived metadata lock.

Within one Burner process, blocking requests (including queued command evaluations) receive FIFO priority over new job leases. This does not change held-lock lifetimes or cross-process exclusion.

Concurrency is configurable but defaults to **1**. This favors slower monotonic progress and prevents speculative agents from invalidating one another. Living-line experiments also take a composite-specific lock, so increasing global concurrency never allows two agents to mutate the same lineage simultaneously.

## Development

```bash
npm install
npm run dev       # Build and run the local app on :4321
npm run typecheck
npm test
npm run build
```

### Programmatic sessions

Use `createBurnerServer({ ..., manual: true })` or `orchestrator.init({ manual: true })` for caller-driven sessions. Manual initialization pauses before normal protection, lock recovery, repository readiness, and any YOLO preflight. It preserves `autoRun` but skips automatic resume and the orchestrator's scheduler/PR-reconciliation timer; ordinary base-branch repair can still update settings. Unlike `startPaused`, no scheduler interval is installed. The server's HTTP API and event heartbeat remain available.

`manual` is not persisted or a permanent isolation boundary: explicit operations, including `setEnabled(true)` and `runCycle()`, can still schedule work. It does not enforce single-idea isolation: `runNextIdea()` can also start queued composites on completion. `fullyValidateLeafForMerge(runId, expectedBaseCommit)` exposes existing full evaluation qualification without merging. It may reuse cached results and update that candidate's PR body; it does not establish review approval, CI, remote-head identity, or atomic base/merge authorization.

## License

MIT
