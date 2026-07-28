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

Options:
  -p, --port <port>  port to listen on (default: 4321)
  --host <host>      host to bind (default: 127.0.0.1)
  --no-open          do not open a browser
  -V, --version      output the version number
  -h, --help         display help
```

Run `burner` from the repo you want to improve, configure evaluation prompts in the UI, and run a baseline. “Ignite” starts the continuous loop. Pausing stops new dispatches but lets already-running agents finish safely.

## Safety and concurrency

Implementation agents receive explicit `workspace-write` access only inside their isolated worktree. Evaluators and the planner are read-only. Burner asks Codex not to push or open PRs; the orchestrator owns those state transitions.

Each idea may declare resource locks. Locks are acquired atomically under `.burner/locks`, in sorted order, and held for the full agent run. If any requested resource is busy, the idea stays queued. Git worktree mutations use a separate short-lived metadata lock.

## Development

```bash
npm install
npm run dev       # Vite middleware + API on :4321
npm run typecheck
npm test
npm run build
```

## License

MIT
