# Burner

Burner is a local control room that continuously improves a repository against the signals you care about. Define evaluations in plain English, score the current repo with `codex exec`, and let an orchestrator turn weak signals into isolated implementation branches and impact-stamped pull requests.

```bash
npm install
npm run build
npm link

cd /path/to/your/repo
burner
# ◉ BURNER → http://127.0.0.1:4321
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

## Usage

```text
Usage: burner [options] [directory]
       burner <command> [subcommand] -C <directory> [options]

Commands:
  eval add       Add an evaluation (--name, --prompt, [--weight])
  eval clear     Remove every evaluation (--yes is required)
  eval list      List evaluations and latest scores
  eval run       Run all enabled evaluations and wait for results
  idea add       Queue an idea (--title, --description, [--impact])
  idea list      List improvement ideas
  queue run-next Run exactly one queued idea through review and delivery
  settings set   Update automation settings
  status         Print project state and runtime readiness as JSON
```

Run `burner` from the repo you want to improve, configure evaluation prompts in the UI, and run a baseline. “Ignite” starts the continuous loop. Pausing stops new dispatches but lets already-running agents finish safely.

The same workflow is scriptable. Commands emit JSON, and `-C` selects the target repository:

```bash
burner eval clear --yes -C ./my-project
burner eval add -C ./my-project --name "Correctness" --prompt "Score correctness and test evidence out of 100"
burner settings set -C ./my-project --parallelism 1 --max-review-rounds 8
burner eval run -C ./my-project
burner idea add -C ./my-project --title "Add crash recovery" --description "Implement and test WAL recovery" --impact 90
burner queue run-next -C ./my-project
```

`queue run-next` is deliberately bounded: it claims the highest-impact queued idea, waits through implementation, the reviewer/author loop, candidate evaluation, and PR delivery, then exits. This makes Burner usable from CI, cron, or a larger local automation script without enabling the continuous timer.

## Review and composite workflow

Each implementation author runs in a persistent Codex session. After the author commits a candidate, Burner starts an independent structured reviewer. Requested changes are fed back by resuming the same author session, and the cycle repeats. A PR is opened only after approval and complete branch evaluations. The configurable review safety limit prevents a pathological loop from consuming resources forever.

The **Master cook** view combines two or more open Burner PRs. Burner creates a worktree from the current base, merges the selected branches, asks an integration author to resolve conflicts and test the result, completes the same review loop, then runs every evaluation on that exact code state. Its composite score is therefore measured directly—not calculated by adding individual scores.

The first composite becomes the **living line**, or you can promote another approved composite from the UI. From then on, planning inspects that branch rather than `main`, and implementation agents start from its latest evaluated commit. Experiments targeting the same line are serialized even when global concurrency is higher. An experiment is absorbed only when its weighted gain clears the configured threshold and no evaluation regresses. Burner then updates the existing composite branch incrementally, reviews the full feature branch again, reruns all evaluations, and updates the same PR. Rejected experiments leave the living line untouched.

This makes the composite behave like a long-running feature program: it can accumulate a year of monotonic, reviewed iteration in one PR while `main` remains unchanged. Burner persists a hidden checkpoint branch after every successful composite update, preserving integration fixes as well as experiment commits. Full reconstruction from that checkpoint is reserved for real base-branch changes or reconciliation after another PR merges.

When a composite merges, Burner closes its included source PRs. It fast-forwards the configured base branch so new agents start from the new main, invalidates the old baseline, and rebuilds every other affected composite after removing PRs that are now merged, closed, or superseded. This reconciliation also runs when a PR is merged from GitHub instead of the Burner dashboard.

## Safety and concurrency

Implementation agents receive explicit `workspace-write` access only inside their isolated worktree. Evaluators and the planner are read-only. Burner asks Codex not to push or open PRs; the orchestrator owns those state transitions.

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
