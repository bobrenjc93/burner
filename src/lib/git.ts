import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompositeSource, GeneratedLeafProgress, LeafManagedPlan, LeafPrContent, LeafRepositoryIdentity, ReviewRound, ScoreDelta } from "../types.js";
import { runCommand } from "./process.js";
import { MANAGED_PROGRESS_FILES, progressReadmeBlock, replaceProgressReadmeBlock } from "./progress.js";

// Retained evidence packs can still be transferring after ten minutes. This
// bounds each push command, not the surrounding publication or its shutdown.
const GIT_PUSH_TIMEOUT_MS = 30 * 60 * 1000;

export type PullRequestDisposition = "merged" | "unmerged";

export type PreparedLeafCommit = { inputHead: string; tree: string; parents?: string[] };

export type PlannedLeafMerge = { inputHead: string; targetCommit: string; tree: string; conflict: boolean; contained: boolean };

type ManagedTreeFile = { blob: string; mode: string; text: string };

export type LeafPullRequestObservation = LeafPrContent & {
  repository: LeafRepositoryIdentity;
  headRepository: LeafRepositoryIdentity;
  baseRepository: LeafRepositoryIdentity;
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit?: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  statusCheckRollup: PullRequestCheck[];
};

export type PullRequestSummary = {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  headRefOid?: string;
  url: string;
  title?: string;
  body?: string;
  isDraft?: boolean;
  labels?: Array<{ name: string }>;
  statusCheckRollup?: PullRequestCheck[];
};

export class TransientMergeGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientMergeGateError";
  }
}

// A malformed proxy HTTP response leaves the request outcome unknown. Retry
// through the existing checked-head gate, not a generic connection/auth match.
const transientGitHubPattern = /connection (?:reset|refused|closed)|error connecting to|network (?:error|failure)|timed? out|timeout|unexpected eof|tls|temporary failure|service unavailable|no route to host|failed to connect|could not resolve host|http (?:429|5\d\d)|malformed HTTP status code|stream (?:error|disconnected)|socket (?:not open|hang up)/i;
// GitHub and forward proxies can report throttling without an HTTP 429. Keep
// these signatures explicit: a generic 403 or authorization error is not a retry.
const rateLimitedGitHubPattern = /\bratelimit by OnRequestRateLimitFilter\b|\b(?:API|secondary) rate limit (?:already )?exceeded\b|\b(?:exceeded|hit) (?:a |the )?(?:API|secondary) rate limit\b/i;

export function isTransientGitHubFailure(error: unknown): boolean {
  if (error instanceof TransientMergeGateError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return transientGitHubPattern.test(message) || rateLimitedGitHubPattern.test(message);
}

type PullRequestMergeStatus = {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefOid: string;
};

export type PullRequestCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
};

type PullRequestCheckStatus = {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  statusCheckRollup: PullRequestCheck[];
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const leafRepositoryFields = "id nameWithOwner url";
const leafGraphEnvironment = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: process.platform === "win32" ? "NUL" : "/dev/null" };
const leafPullRequestFields = `number url headRefName headRefOid baseRefName baseRefOid state title body isDraft mergeable
  headRepository { ${leafRepositoryFields} } baseRepository { ${leafRepositoryFields} } mergeCommit { oid }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) {
    totalCount pageInfo { hasNextPage } nodes {
      __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
    }
  } } } } }`;

function leafRecord(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Missing or invalid leaf ${description}.`);
  return value as Record<string, unknown>;
}

function leafText(value: unknown, description: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new Error(`Missing or invalid leaf ${description}.`);
  return value;
}

function leafOid(value: unknown, description: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(`Expected an exact leaf ${description} commit OID.`);
  return value;
}

function leafRepositoryName(value: unknown): string {
  const name = leafText(value, "repository name");
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(name) || name.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Invalid leaf repository name.");
  }
  return name;
}

function leafRepositoryHost(value: unknown): string {
  const host = leafText(value, "repository host");
  const parsed = new URL(`https://${host}`);
  if (parsed.host !== host || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Invalid leaf repository host.");
  }
  return host;
}

function sameLeafRepository(left: LeafRepositoryIdentity, right: LeafRepositoryIdentity): boolean {
  return left.host === right.host && left.id === right.id && left.nameWithOwner === right.nameWithOwner;
}

export class GitService {
  private dispositionLabelsReady = false;

  constructor(
    readonly root: string,
    private readonly dataDir: string,
    private readonly mergePolling: { attempts?: number; intervalMs?: number; mergeAttempts?: number; checkAttempts?: number; noCheckGraceAttempts?: number; transportAttempts?: number } = {},
  ) {}

  private async githubJson<T>(cwd: string, args: string[], description: string): Promise<T> {
    const attempts = this.mergePolling.transportAttempts ?? 5;
    const intervalMs = this.mergePolling.intervalMs ?? 2_500;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await runCommand("gh", args, { cwd, timeoutMs: 2 * 60 * 1000 });
      if (result.exitCode === 0) {
        try { return JSON.parse(result.stdout) as T; }
        catch (error) {
          lastError = `Could not parse GitHub response while ${description}: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        lastError = result.stderr.trim() || result.stdout.trim() || `Could not ${description}`;
      }
      if (!isTransientGitHubFailure(lastError)) throw new Error(lastError);
      if (attempt < attempts) await wait(intervalMs);
    }
    throw new TransientMergeGateError(lastError || `GitHub remained unavailable while ${description}.`);
  }

  private leafRepositoryArgument(repository: LeafRepositoryIdentity): string {
    leafText(repository?.id, "repository node identity");
    return `${leafRepositoryHost(repository?.host)}/${leafRepositoryName(repository?.nameWithOwner)}`;
  }

  private remoteLeafRepository(url: string): { host: string; nameWithOwner: string } {
    try {
      const scp = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(url);
      const parsed = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : url);
      if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.search || parsed.hash || !parsed.hostname) throw new Error("Unsupported remote");
      const host = leafRepositoryHost(parsed.protocol === "ssh:" ? parsed.hostname : parsed.host);
      const nameWithOwner = leafRepositoryName(parsed.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, ""));
      return { host, nameWithOwner };
    } catch { throw new Error("Leaf Git remote does not identify one GitHub host/repository."); }
  }

  private observedLeafRepository(value: unknown, host: string): LeafRepositoryIdentity {
    const data = leafRecord(value, "repository identity");
    const id = leafText(data.id, "repository node identity");
    const nameWithOwner = leafRepositoryName(data.nameWithOwner);
    const url = new URL(leafText(data.url, "repository URL"));
    if (url.protocol !== "https:" || url.host !== host || url.username || url.password || url.search || url.hash || url.pathname !== `/${nameWithOwner}`) {
      throw new Error("Leaf repository observation has a different host/name identity.");
    }
    return { host, id, nameWithOwner };
  }

  private async leafGraphql(cwd: string, host: string, operationName: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await runCommand("gh", ["api", "graphql", "--hostname", leafRepositoryHost(host), "--method", "POST", "--input", "-"], {
      cwd, input: JSON.stringify({ operationName, query, variables }), timeoutMs: 2 * 60 * 1000,
    });
    if (response.exitCode !== 0) throw new Error(response.stderr.trim() || "Could not observe the exact leaf GitHub identity.");
    let payload: Record<string, unknown>;
    try { payload = leafRecord(JSON.parse(response.stdout), "GraphQL response"); }
    catch { throw new Error("Invalid leaf GitHub GraphQL response."); }
    if (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length)) throw new Error("Leaf GitHub GraphQL returned incomplete data or errors.");
    return leafRecord(payload.data, "GitHub observation data");
  }

  async leafRepository(cwd: string, remote: string): Promise<LeafRepositoryIdentity> {
    const results = await Promise.all([
      runCommand("git", ["remote", "get-url", "--all", remote], { cwd }),
      runCommand("git", ["remote", "get-url", "--push", "--all", remote], { cwd }),
    ]);
    if (results.some((result) => result.exitCode !== 0 || !result.stdout.trim())) throw new Error("Could not establish the leaf remote fetch/push identity.");
    const coordinates = results.flatMap((result) => result.stdout.trim().split("\n").map((url) => this.remoteLeafRepository(url)));
    const expected = coordinates[0]!;
    if (coordinates.some((item) => item.host !== expected.host || item.nameWithOwner.toLowerCase() !== expected.nameWithOwner.toLowerCase())) {
      throw new Error("Leaf remote fetch and push URLs disagree on repository identity.");
    }
    const [owner, name] = expected.nameWithOwner.split("/");
    const data = await this.leafGraphql(cwd, expected.host, "LeafRepository",
      `query LeafRepository($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${leafRepositoryFields} } }`, { owner, name });
    const repository = this.observedLeafRepository(data.repository, expected.host);
    if (repository.nameWithOwner.toLowerCase() !== expected.nameWithOwner.toLowerCase()) throw new Error("Leaf remote resolved to a different repository identity.");
    return repository;
  }

  private async assertLeafRepository(cwd: string, remote: string, expected: LeafRepositoryIdentity): Promise<void> {
    this.leafRepositoryArgument(expected);
    if (!sameLeafRepository(await this.leafRepository(cwd, remote), expected)) throw new Error("The leaf remote repository identity changed.");
  }

  private async assertLeafRef(cwd: string, ref: string): Promise<void> {
    const checked = typeof ref === "string" && ref ? await runCommand("git", ["check-ref-format", "--branch", ref], { cwd }) : undefined;
    // --branch expands checkout expressions such as @{-1}; observations must
    // identify the literal ref, never an interpretation of local reflog state.
    if (!checked || checked.exitCode !== 0 || checked.stdout.trim() !== ref) {
      throw new Error("Invalid leaf PR branch/ref observation.");
    }
  }

  private leafPrNumber(number: unknown): number {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid leaf PR number observation.");
    return number;
  }

  private leafPrUrl(value: unknown, repository: LeafRepositoryIdentity, number: number): string {
    const text = leafText(value, "PR URL observation");
    const url = new URL(text);
    if (url.protocol !== "https:" || url.host !== repository.host || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/${repository.nameWithOwner}/pull/${number}`) throw new Error("Leaf PR URL does not match its repository/number identity.");
    return text;
  }

  private async observedLeafPr(cwd: string, repository: LeafRepositoryIdentity, value: unknown): Promise<LeafPullRequestObservation> {
    const data = leafRecord(value, "PR observation");
    const number = this.leafPrNumber(data.number);
    const url = this.leafPrUrl(data.url, repository, number);
    const headRefName = leafText(data.headRefName, "PR head ref observation");
    const baseRefName = leafText(data.baseRefName, "PR base ref observation");
    const headRefOid = leafOid(data.headRefOid, "PR head");
    const baseRefOid = leafOid(data.baseRefOid, "PR base");
    const headRepository = this.observedLeafRepository(data.headRepository, repository.host);
    const baseRepository = this.observedLeafRepository(data.baseRepository, repository.host);
    const title = leafText(data.title, "PR title observation");
    const body = leafText(data.body, "PR body observation", true);
    if (typeof data.isDraft !== "boolean" || typeof data.state !== "string" || !["OPEN", "CLOSED", "MERGED"].includes(data.state) ||
      typeof data.mergeable !== "string" || !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(data.mergeable) || !("mergeCommit" in data)) {
      throw new Error("Missing or invalid leaf PR lifecycle/mergeability observation fields.");
    }
    const state = data.state as LeafPullRequestObservation["state"];
    const mergeable = data.mergeable as LeafPullRequestObservation["mergeable"];
    const mergeCommit = data.mergeCommit === null ? undefined : leafOid(leafRecord(data.mergeCommit, "PR landing observation").oid, "PR landing");
    if (state === "MERGED" && !mergeCommit) throw new Error("Merged leaf PR observation lacks its associated landing commit.");
    await Promise.all([this.assertLeafRef(cwd, headRefName), this.assertLeafRef(cwd, baseRefName)]);
    const commits = leafRecord(data.commits, "PR head commit observation");
    if (!Array.isArray(commits.nodes) || commits.nodes.length !== 1) throw new Error("Leaf PR observation lacks one exact head commit.");
    const commit = leafRecord(leafRecord(commits.nodes[0], "PR commit node").commit, "PR head commit");
    if (commit.oid !== headRefOid || !("statusCheckRollup" in commit)) throw new Error("Leaf PR checks do not identify its exact head commit.");
    let statusCheckRollup: PullRequestCheck[] = [];
    if (commit.statusCheckRollup !== null) {
      const contexts = leafRecord(leafRecord(commit.statusCheckRollup, "PR check rollup").contexts, "PR checks");
      const info = leafRecord(contexts.pageInfo, "PR check page");
      if (!Array.isArray(contexts.nodes) || !Number.isSafeInteger(contexts.totalCount) || contexts.totalCount !== contexts.nodes.length || info.hasNextPage !== false) {
        throw new Error("Leaf PR check observation is missing or truncated.");
      }
      statusCheckRollup = contexts.nodes.map((value: unknown): PullRequestCheck => {
        const check = leafRecord(value, "PR check");
        if (check.__typename === "CheckRun") {
          const name = leafText(check.name, "PR check name");
          const status = leafText(check.status, "PR check status");
          if (!["QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "REQUESTED", "PENDING"].includes(status) ||
            !(check.conclusion === null || typeof check.conclusion === "string" && ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "NEUTRAL", "SKIPPED", "STALE", "STARTUP_FAILURE", "SUCCESS", "TIMED_OUT"].includes(check.conclusion))) {
            throw new Error("Invalid leaf PR check status/conclusion observation.");
          }
          return { __typename: "CheckRun", name, status, ...(check.conclusion === null ? {} : { conclusion: check.conclusion }) };
        }
        if (check.__typename === "StatusContext") {
          const context = leafText(check.context, "PR check context");
          const state = leafText(check.state, "PR check state");
          if (!["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"].includes(state)) throw new Error("Invalid leaf PR check state observation.");
          return { __typename: "StatusContext", context, state };
        }
        throw new Error("Unknown leaf PR check observation type.");
      });
    }
    return { repository, headRepository, baseRepository, number, url, headRefName, headRefOid, baseRefName, baseRefOid,
      title, body, isDraft: data.isDraft, state, mergeable, ...(mergeCommit ? { mergeCommit } : {}), statusCheckRollup };
  }

  private observedLeafRepositoryNode(data: Record<string, unknown>, repository: LeafRepositoryIdentity): Record<string, unknown> {
    const node = leafRecord(data.node, "repository observation");
    if (!sameLeafRepository(this.observedLeafRepository(node, repository.host), repository)) throw new Error("Leaf PR repository identity changed.");
    return node;
  }

  async observeLeafPr(cwd: string, repository: LeafRepositoryIdentity, number: number): Promise<LeafPullRequestObservation> {
    this.leafRepositoryArgument(repository);
    this.leafPrNumber(number);
    const data = await this.leafGraphql(cwd, repository.host, "LeafPullRequest",
      `query LeafPullRequest($repository: ID!, $number: Int!) { node(id: $repository) { ... on Repository {
        ${leafRepositoryFields} pullRequest(number: $number) { ${leafPullRequestFields} }
      } } }`, { repository: repository.id, number });
    const observed = await this.observedLeafPr(cwd, repository, this.observedLeafRepositoryNode(data, repository).pullRequest);
    if (observed.number !== number) throw new Error("Leaf PR observation changed number identity.");
    return observed;
  }

  async findLeafPrs(cwd: string, repository: LeafRepositoryIdentity, branch: string): Promise<LeafPullRequestObservation[]> {
    this.leafRepositoryArgument(repository);
    await this.assertLeafRef(cwd, branch);
    const found: LeafPullRequestObservation[] = [];
    const numbers = new Set<number>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let total: number | undefined;
    while (true) {
      const data = await this.leafGraphql(cwd, repository.host, "LeafPullRequests",
        `query LeafPullRequests($repository: ID!, $branch: String!, $after: String) { node(id: $repository) { ... on Repository {
          ${leafRepositoryFields} pullRequests(first: 100, after: $after, headRefName: $branch, states: [OPEN, CLOSED, MERGED]) {
            totalCount pageInfo { hasNextPage endCursor } edges { cursor node { ${leafPullRequestFields} } }
          }
        } } }`, { repository: repository.id, branch, after });
      const page = leafRecord(this.observedLeafRepositoryNode(data, repository).pullRequests, "PR discovery page");
      const info = leafRecord(page.pageInfo, "PR discovery page info");
      if (typeof page.totalCount !== "number" || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 ||
        total !== undefined && total !== page.totalCount || !Array.isArray(page.edges) || page.edges.length > 100 || typeof info.hasNextPage !== "boolean") {
        throw new Error("Leaf PR discovery has incomplete pages or a changed total count.");
      }
      total ??= page.totalCount;
      let end: string | null = null;
      for (const value of page.edges) {
        const edge = leafRecord(value, "PR discovery edge");
        end = leafText(edge.cursor, "PR discovery cursor");
        const observed = await this.observedLeafPr(cwd, repository, edge.node);
        if (cursors.has(end) || numbers.has(observed.number) || observed.headRefName !== branch) throw new Error("Leaf PR discovery repeated a cursor/PR or returned a different branch.");
        cursors.add(end);
        numbers.add(observed.number);
        found.push(observed);
      }
      if (info.endCursor !== end || found.length > total || info.hasNextPage !== (found.length < total) || info.hasNextPage && !end) {
        throw new Error("Leaf PR discovery is truncated or has an incomplete cursor page.");
      }
      if (!info.hasNextPage) return found;
      after = end;
    }
  }

  private async leafPrMutation(cwd: string, repository: LeafRepositoryIdentity, args: string[]): Promise<string> {
    const result = await runCommand("gh", [...args, "--repo", this.leafRepositoryArgument(repository)], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Leaf PR mutation failed without acknowledgement.");
    return result.stdout;
  }

  async createLeafPr(options: { cwd: string; repository: LeafRepositoryIdentity; baseBranch: string; branch: string; title: string; body: string; isDraft: boolean }): Promise<{ url: string; number?: number }> {
    const { cwd, repository, baseBranch, branch, title, body, isDraft } = options;
    leafText(title, "PR title"); leafText(body, "PR body", true);
    if (typeof isDraft !== "boolean") throw new Error("Missing leaf PR draft target.");
    await Promise.all([this.assertLeafRef(cwd, branch), this.assertLeafRef(cwd, baseBranch)]);
    const output = await this.leafPrMutation(cwd, repository, ["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body", body, ...(isDraft ? ["--draft"] : [])]);
    const url = output.trim().split("\n").at(-1);
    const number = this.leafPrNumber(Number(/\/pull\/(\d+)$/.exec(url ?? "")?.[1]));
    return { url: this.leafPrUrl(url, repository, number), number };
  }

  async editLeafPrField(cwd: string, repository: LeafRepositoryIdentity, number: number, field: "title" | "body", value: string): Promise<void> {
    if (field !== "title" && field !== "body") throw new Error("Unknown leaf PR content field.");
    leafText(value, `PR ${field}`, field === "body");
    await this.leafPrMutation(cwd, repository, ["pr", "edit", String(this.leafPrNumber(number)), `--${field}`, value]);
  }

  async setLeafPrDraft(cwd: string, repository: LeafRepositoryIdentity, number: number, isDraft: boolean): Promise<void> {
    if (typeof isDraft !== "boolean") throw new Error("Missing leaf PR draft target.");
    await this.leafPrMutation(cwd, repository, ["pr", "ready", String(this.leafPrNumber(number)), ...(isDraft ? ["--undo"] : [])]);
  }

  async closeLeafPr(cwd: string, repository: LeafRepositoryIdentity, number: number): Promise<void> {
    await this.leafPrMutation(cwd, repository, ["pr", "close", String(this.leafPrNumber(number))]);
  }

  async mergeLeafPr(cwd: string, repository: LeafRepositoryIdentity, number: number, expectedHead: string): Promise<void> {
    try {
      await this.leafPrMutation(cwd, repository, ["pr", "merge", String(this.leafPrNumber(number)), "--merge", "--match-head-commit", leafOid(expectedHead, "merge head")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientGitHubFailure(error) || /not mergeable|mergeability|pull request.*(?:not open|closed)|head (?:branch|sha).*(?:changed|updated)|base branch.*(?:changed|updated)/i.test(message)) {
        throw new TransientMergeGateError(message);
      }
      throw error;
    }
  }

  leafMergePolling(): { mergeAttempts: number; checkAttempts: number; noCheckGraceAttempts: number; intervalMs: number } {
    const checkAttempts = this.mergePolling.checkAttempts ?? 360;
    return { mergeAttempts: this.mergePolling.mergeAttempts ?? 24, checkAttempts,
      noCheckGraceAttempts: Math.min(checkAttempts, this.mergePolling.noCheckGraceAttempts ?? 4), intervalMs: this.mergePolling.intervalMs ?? 2_500 };
  }

  private async pruneWorktrees(): Promise<void> {
    const prune = await runCommand("git", ["worktree", "prune", "--expire", "now"], { cwd: this.root });
    if (prune.exitCode !== 0) throw new Error(prune.stderr.trim() || "Could not prune stale worktree registrations");
  }

  private async prepareWorktreePath(path: string, worktreesDir: string): Promise<void> {
    await mkdir(worktreesDir, { recursive: true });
    await rm(path, { recursive: true, force: true });
    await this.pruneWorktrees();
  }

  private async reuseExistingWorktree(path: string, branch: string): Promise<boolean> {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) return false;
    const mismatch = () => new Error("Refusing to recreate existing worktree " + path + ": its repository or branch does not match; saved files were left untouched.");
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw mismatch();

    const [top, common, head, expectedCommon] = await Promise.all([
      runCommand("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: path }),
      runCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path }),
      runCommand("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: path }),
      runCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: this.root }),
    ]);
    if ([top, common, head, expectedCommon].some((result) => result.exitCode !== 0)) throw mismatch();
    const [actualPath, topPath, commonPath, expectedCommonPath] = await Promise.all([
      realpath(path), realpath(top.stdout.trim()), realpath(common.stdout.trim()), realpath(expectedCommon.stdout.trim()),
    ]);
    const branchRef = branch.startsWith("refs/heads/") ? branch : "refs/heads/" + branch;
    if (topPath !== actualPath || commonPath !== expectedCommonPath || head.stdout.trim() !== branchRef) throw mismatch();
    return true;
  }

  async status(): Promise<{ available: boolean; branch?: string; commit?: string; dirty?: boolean }> {
    const inside = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.root }).catch(() => undefined);
    if (!inside || inside.exitCode !== 0) return { available: false };
    const [branch, commit, dirty] = await Promise.all([
      runCommand("git", ["branch", "--show-current"], { cwd: this.root }),
      runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: this.root }),
      runCommand("git", ["status", "--porcelain"], { cwd: this.root }),
    ]);
    return {
      available: true,
      branch: branch.stdout.trim() || undefined,
      commit: commit.stdout.trim() || undefined,
      dirty: Boolean(dirty.stdout.trim()),
    };
  }

  async head(cwd = this.root): Promise<string> {
    const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not resolve git HEAD");
    return result.stdout.trim();
  }

  async resolveRef(ref: string): Promise<string> {
    const result = await runCommand("git", ["rev-parse", ref], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not resolve ${ref}`);
    return result.stdout.trim();
  }

  async tree(ref: string): Promise<string> {
    const result = await runCommand("git", ["rev-parse", `${ref}^{tree}`], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not resolve tree for ${ref}`);
    return result.stdout.trim();
  }

  async hasRef(ref: string): Promise<boolean> {
    return (await runCommand("git", ["rev-parse", "--verify", ref], { cwd: this.root })).exitCode === 0;
  }

  async createWorktree(runId: string, branch: string, baseBranch: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await this.prepareWorktreePath(path, worktreesDir);
    // Agent branches may start from a remote-tracking living composite. Do not
    // inherit that ref as their upstream: an agent-side plain `git push` would
    // otherwise update the shared composite PR branch instead of its own branch.
    const result = await runCommand("git", ["worktree", "add", "--no-track", "-b", branch, path, baseBranch], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not create worktree");
    return path;
  }

  async createDetachedWorktree(runId: string, ref: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await this.prepareWorktreePath(path, worktreesDir);
    const result = await runCommand("git", ["worktree", "add", "--detach", path, ref], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not create planning worktree at ${ref}`);
    return path;
  }

  async createRebuildWorktree(runId: string, branch: string, baseBranch: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await this.prepareWorktreePath(path, worktreesDir);
    const add = await runCommand("git", ["worktree", "add", path, branch], { cwd: this.root });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not recreate composite worktree");
    const reset = await runCommand("git", ["reset", "--hard", baseBranch], { cwd: path });
    if (reset.exitCode !== 0) throw new Error(reset.stderr.trim() || `Could not reset composite to ${baseBranch}`);
    return path;
  }

  async createExistingWorktree(runId: string, branch: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    // Resuming must retain staged, unstaged, untracked, and ignored files.
    // In particular, an interrupted author may not have committed its work yet.
    if (await this.reuseExistingWorktree(path, branch)) return path;
    await mkdir(worktreesDir, { recursive: true });
    await this.pruneWorktrees();
    const add = await runCommand("git", ["worktree", "add", path, branch], { cwd: this.root });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not check out the living composite worktree");
    return path;
  }

  async mergeBranch(cwd: string, branch: string): Promise<{ merged: boolean; conflict: boolean }> {
    const result = await runCommand(
      "git",
      ["-c", "user.name=Burner", "-c", "user.email=burner@localhost", "merge", "--no-ff", "--no-edit", branch],
      { cwd },
    );
    if (result.exitCode === 0) return { merged: true, conflict: false };
    const status = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd });
    if (status.stdout.trim()) return { merged: false, conflict: true };
    throw new Error(result.stderr.trim() || `Could not merge ${branch}`);
  }

  async fetchBranch(remote: string, branch: string): Promise<string> {
    const result = await runCommand("git", ["fetch", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd: this.root, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not fetch ${remote}/${branch}`);
    return `${remote}/${branch}`;
  }

  async hasChanges(cwd: string): Promise<boolean> {
    const result = await runCommand("git", ["status", "--porcelain"], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not inspect worktree changes");
    return Boolean(result.stdout.trim());
  }

  async assertWorktree(cwd: string, branch: string): Promise<void> {
    if (!(await this.reuseExistingWorktree(cwd, branch))) {
      throw new Error("The saved candidate worktree is missing; its identity cannot be verified.");
    }
  }

  async assertLeafWorktreeIdle(cwd: string): Promise<void> {
    if ((await this.leafMergeHeads(cwd)).length) throw new Error("Unexpected candidate Git merge operation; retained files were left untouched.");
  }

  private async assertPreparedTree(cwd: string, tree: string, env?: NodeJS.ProcessEnv): Promise<void> {
    // Both write-tree and diff can refresh the index, including a temporary
    // conflict-verification index. Finish its mandatory lock before diff.
    const index = await runCommand("git", ["write-tree"], { cwd, env });
    const [unstaged, untracked] = await Promise.all([
      runCommand("git", ["diff", "--quiet", "--"], { cwd, env }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, env }),
    ]);
    if (index.exitCode !== 0 || index.stdout.trim() !== tree || unstaged.exitCode !== 0 ||
      untracked.exitCode !== 0 || untracked.stdout) {
      throw new Error("The prepared candidate tree changed; staged, unstaged, and untracked files were left untouched.");
    }
  }

  private async leafMergeHeads(cwd: string): Promise<string[]> {
    const directory = await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd });
    if (directory.exitCode !== 0) throw new Error(directory.stderr.trim() || "Could not inspect candidate Git operation state");
    const gitDir = directory.stdout.trim();
    for (const name of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      const present = await lstat(join(gitDir, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (present) throw new Error(`Unexpected candidate Git operation ${name}; files were left untouched.`);
    }
    const contents = await readFile(join(gitDir, "MERGE_HEAD"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (contents === undefined) return [];
    const heads = contents.trim().split("\n");
    if (heads.some((head) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))) {
      throw new Error("Unexpected candidate MERGE_HEAD; files were left untouched.");
    }
    return heads;
  }

  private async assertLeafParents(cwd: string, inputHead: string, parents: string[]): Promise<void> {
    if (parents[0] !== inputHead || ![1, 2].includes(parents.length) || new Set(parents).size !== parents.length) {
      throw new Error("Invalid saved candidate parent receipt; files were left untouched.");
    }
    const merging = await this.leafMergeHeads(cwd);
    if (JSON.stringify(merging) !== JSON.stringify(parents.slice(1))) {
      throw new Error("Candidate MERGE_HEAD does not match the saved parent receipt; files were left untouched.");
    }
  }

  /** Stage the returned model result before its durable StateStore receipt. */
  async prepareLeafCommit(cwd: string, branch: string, inputHead: string, parents?: string[]): Promise<PreparedLeafCommit> {
    await this.assertWorktree(cwd, branch);
    if (await this.head(cwd) !== inputHead) throw new Error("The author changed HEAD; Burner owns candidate commits.");
    await this.assertLeafParents(cwd, inputHead, parents ?? [inputHead]);
    const add = await runCommand("git", ["add", "-A"], { cwd });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not stage the completed author result");
    const staged = await runCommand("git", ["write-tree"], { cwd });
    if (staged.exitCode !== 0) throw new Error(staged.stderr.trim() || "Could not identify the completed author tree");
    const tree = staged.stdout.trim();
    await this.assertPreparedTree(cwd, tree);
    await this.assertWorktree(cwd, branch);
    if (await this.head(cwd) !== inputHead) throw new Error("Candidate HEAD moved while preparing the author receipt.");
    return { inputHead, tree, ...(parents ? { parents } : {}) };
  }

  /** Finish a durable receipt, or recognize its exact already-created commit. */
  async finalizeLeafCommit(cwd: string, branch: string, prepared: PreparedLeafCommit, message: string): Promise<string> {
    await this.assertWorktree(cwd, branch);
    const expectedParents = prepared.parents ?? [prepared.inputHead];
    if (expectedParents[0] !== prepared.inputHead || ![1, 2].includes(expectedParents.length) || new Set(expectedParents).size !== expectedParents.length) {
      throw new Error("Invalid saved candidate parent receipt; files were left untouched.");
    }
    let head = await this.head(cwd);
    if (head === prepared.inputHead) {
      await this.assertLeafParents(cwd, prepared.inputHead, expectedParents);
      await this.assertPreparedTree(cwd, prepared.tree);
      if (expectedParents.length === 1 && await this.tree(head) === prepared.tree) return head;
      const committed = await runCommand("git", ["-c", "user.name=Burner", "-c", "user.email=burner@localhost", "commit", "-m", message], { cwd });
      if (committed.exitCode !== 0) throw new Error(committed.stderr.trim() || "Could not finalize the completed author result");
      head = await this.head(cwd);
    }
    const parents = await runCommand("git", ["rev-list", "--parents", "-n", "1", head], { cwd });
    if (parents.exitCode !== 0 || parents.stdout.trim() !== [head, ...expectedParents].join(" ") ||
      await this.tree(head) !== prepared.tree || await this.hasChanges(cwd) || (await this.leafMergeHeads(cwd)).length) {
      throw new Error("Candidate commit does not match the saved parent/tree receipt; files were left untouched.");
    }
    await this.assertWorktree(cwd, branch);
    return head;
  }

  private async assertExactCommit(cwd: string, commit: string, env?: NodeJS.ProcessEnv): Promise<void> {
    const result = await runCommand("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd, env });
    if (result.exitCode !== 0 || result.stdout.trim() !== commit) throw new Error(`Expected an exact available commit, got '${commit}'.`);
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
    const result = await runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, env });
    if (![0, 1].includes(result.exitCode)) throw new Error(result.stderr.trim() || "Could not verify candidate ancestry");
    return result.exitCode === 0;
  }

  async isCommitAncestor(ancestor: string, descendant: string): Promise<boolean> {
    await this.assertExactCommit(this.root, ancestor);
    await this.assertExactCommit(this.root, descendant);
    return this.isAncestor(this.root, ancestor, descendant);
  }

  private async fetchLeafCommits(remote: string, commits: string[]): Promise<void> {
    const exact = [...new Set(commits.map((commit) => leafOid(commit, "immutable source")))];
    const fetched = await runCommand("git", ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", remote, ...exact], {
      cwd: this.root, env: leafGraphEnvironment, timeoutMs: 10 * 60 * 1000,
    });
    if (fetched.exitCode !== 0) throw new Error(`Could not fetch immutable leaf commits: ${fetched.stderr.trim() || "objects unavailable"}`);
    for (const commit of exact) await this.assertExactCommit(this.root, commit, leafGraphEnvironment);
  }

  async fetchLeafSource(options: { remote: string; repository: LeafRepositoryIdentity; branch: string; head: string }): Promise<void> {
    const { remote, repository, branch, head } = options;
    leafOid(head, "source head");
    await this.assertLeafRepository(this.root, remote, repository);
    if (await this.remoteBranchHead(this.root, remote, branch) !== head) throw new Error("Leaf remote source does not have its exact owned head.");
    await this.fetchLeafCommits(remote, [head]);
    await this.assertLeafRepository(this.root, remote, repository);
    if (await this.remoteBranchHead(this.root, remote, branch) !== head) throw new Error("Leaf remote source head changed during immutable acquisition.");
  }

  async proveLeafInclusion(options: { remote: string; repository: LeafRepositoryIdentity; baseBranch: string; sourceBase: string; head: string; landing?: string }): Promise<{ targetCommit: string }> {
    const { remote, repository, baseBranch, sourceBase, head, landing } = options;
    leafOid(sourceBase, "recorded source base");
    leafOid(head, "source head");
    if (landing !== undefined) leafOid(landing, "associated landing");
    await this.assertLeafRepository(this.root, remote, repository);
    const targetCommit = await this.remoteBranchHead(this.root, remote, baseBranch);
    if (!targetCommit) throw new Error("The actual leaf remote target ref is missing; local main is not an inclusion proof.");
    await this.fetchLeafCommits(remote, [sourceBase, head, targetCommit, ...(landing !== undefined ? [landing] : [])]);
    const edges = [[sourceBase, head], [sourceBase, targetCommit], [head, landing ?? targetCommit], ...(landing ? [[landing, targetCommit]] : [])];
    for (const [ancestor, descendant] of edges) {
      if (!await this.isAncestor(this.root, ancestor!, descendant!, leafGraphEnvironment)) {
        throw new Error("Exact leaf source/base/landing ancestry does not prove inclusion in the remote target.");
      }
    }
    await this.assertLeafRepository(this.root, remote, repository);
    if (await this.remoteBranchHead(this.root, remote, baseBranch) !== targetCommit) throw new Error("The actual leaf remote target moved during immutable inclusion proof.");
    return { targetCommit };
  }

  private async readLeafMergeTree(cwd: string, input: string, target: string): Promise<{ tree: string; conflict: boolean; stages: string[] }> {
    const result = await runCommand("git", ["merge-tree", "--write-tree", "--no-messages", "-z", input, target], { cwd });
    const [tree, ...stages] = result.stdout.split("\0");
    if (![0, 1].includes(result.exitCode) || !tree || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) {
      throw new Error(result.stderr.trim() || "Could not plan the pinned leaf merge");
    }
    return { tree, conflict: result.exitCode === 1, stages: stages.filter(Boolean) };
  }

  async planLeafMerge(cwd: string, branch: string, inputHead: string, targetCommit: string): Promise<PlannedLeafMerge> {
    await this.assertWorktree(cwd, branch);
    await this.assertExactCommit(cwd, targetCommit);
    if (await this.head(cwd) !== inputHead || await this.hasChanges(cwd) || (await this.leafMergeHeads(cwd)).length) {
      throw new Error("Pinned leaf merge requires its clean input head; files were left untouched.");
    }
    const contained = await this.isAncestor(cwd, targetCommit, inputHead);
    // HEAD is checked on both sides. Its spelling also gives merge-tree the
    // same conflict labels as the later pinned `git merge` invocation.
    const snapshot = contained ? { tree: await this.tree(inputHead), conflict: false } : await this.readLeafMergeTree(cwd, "HEAD", targetCommit);
    if (await this.head(cwd) !== inputHead) throw new Error("Candidate HEAD moved while planning the pinned merge.");
    return { inputHead, targetCommit, tree: snapshot.tree, conflict: snapshot.conflict, contained };
  }

  private async withLeafIndex<T>(cwd: string, tree: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "burner-leaf-index-"));
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    try {
      const read = await runCommand("git", ["read-tree", tree], { cwd, env });
      if (read.exitCode !== 0) throw new Error(read.stderr.trim() || "Could not read the saved leaf tree");
      return await action(env);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async assertPlannedMerge(cwd: string, plan: PlannedLeafMerge): Promise<void> {
    await this.assertLeafParents(cwd, plan.inputHead, [plan.inputHead, plan.targetCommit]);
    if (!plan.conflict) { await this.assertPreparedTree(cwd, plan.tree); return; }
    const snapshot = await this.readLeafMergeTree(cwd, "HEAD", plan.targetCommit);
    if (!snapshot.conflict || snapshot.tree !== plan.tree) throw new Error("The saved leaf conflict plan no longer matches Git.");
    const conflicted = new Set<string>();
    for (const entry of snapshot.stages) {
      const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Could not identify the planned conflict stages; files were left untouched.");
      conflicted.add(match[4]!);
    }
    const [tree, index] = await Promise.all([
      runCommand("git", ["ls-tree", "-r", "-z", plan.tree], { cwd }),
      runCommand("git", ["ls-files", "--stage", "-z"], { cwd }),
    ]);
    if (tree.exitCode !== 0 || index.exitCode !== 0) throw new Error("Could not verify the prepared conflict index.");
    const expected = [...snapshot.stages];
    for (const entry of tree.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Could not identify the planned conflict tree.");
      if (!conflicted.has(match[3]!)) expected.push(`${match[1]} ${match[2]} 0\t${match[3]}`);
    }
    if (JSON.stringify(expected.sort()) !== JSON.stringify(index.stdout.split("\0").filter(Boolean).sort())) {
      throw new Error("The prepared conflict index changed; files were left untouched.");
    }
    await this.withLeafIndex(cwd, plan.tree, (env) => this.assertPreparedTree(cwd, plan.tree, env));
  }

  private async assertMergePreservesUntracked(cwd: string, plan: PlannedLeafMerge): Promise<void> {
    const added = await runCommand("git", ["diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames", "--diff-filter=A", "-z", plan.inputHead, plan.tree], { cwd });
    if (added.exitCode !== 0) throw new Error(added.stderr.trim() || "Could not inspect paths introduced by the pinned merge");
    for (const path of added.stdout.split("\0").filter(Boolean)) {
      let prefix = "";
      for (const component of path.split("/")) {
        prefix = prefix ? `${prefix}/${component}` : component;
        const existing = await lstat(join(cwd, prefix)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!existing) break;
        if (existing.isDirectory()) {
          if (prefix === path) {
            const ignored = await runCommand("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", path], { cwd });
            if (ignored.exitCode !== 0 || ignored.stdout) throw new Error(`Pinned merge would overwrite untracked contents of ${path}; files were left untouched.`);
          }
          continue;
        }
        const tracked = await runCommand("git", ["ls-tree", "-z", plan.inputHead, "--", prefix], { cwd });
        if (tracked.exitCode !== 0 || !tracked.stdout) throw new Error(`Pinned merge would overwrite untracked ${prefix}; files were left untouched.`);
        break;
      }
    }
  }

  async prepareLeafMerge(cwd: string, branch: string, plan: PlannedLeafMerge): Promise<void> {
    await this.assertWorktree(cwd, branch);
    await this.assertExactCommit(cwd, plan.targetCommit);
    if (await this.head(cwd) !== plan.inputHead) {
      if (plan.contained || plan.conflict) throw new Error("Candidate HEAD does not match the saved merge input; files were left untouched.");
      await this.finalizeLeafCommit(cwd, branch, { inputHead: plan.inputHead, tree: plan.tree, parents: [plan.inputHead, plan.targetCommit] }, "Pinned leaf base merge");
      return;
    }
    const contained = await this.isAncestor(cwd, plan.targetCommit, plan.inputHead);
    const snapshot = contained ? { tree: await this.tree(plan.inputHead), conflict: false } : await this.readLeafMergeTree(cwd, "HEAD", plan.targetCommit);
    if (contained !== plan.contained || snapshot.tree !== plan.tree || snapshot.conflict !== plan.conflict) {
      throw new Error("The pinned leaf merge does not match its saved plan; files were left untouched.");
    }
    const merging = await this.leafMergeHeads(cwd);
    if (merging.length) { await this.assertPlannedMerge(cwd, plan); return; }
    if (await this.hasChanges(cwd)) throw new Error("Unexpected changes before the pinned leaf merge; files were left untouched.");
    if (contained) return;
    // Some ort versions still overwrite ignored files despite the merge flag.
    // Check only incoming paths, without walking unrelated archived artifacts.
    await this.assertMergePreservesUntracked(cwd, plan);
    const result = await runCommand("git", [
      "-c", "user.name=Burner", "-c", "user.email=burner@localhost", "-c", "rerere.enabled=false",
      "merge", "--no-ff", "--no-commit", "--no-autostash", "--no-squash", "--no-overwrite-ignore", "--strategy=ort", plan.targetCommit,
    ], { cwd });
    if (result.exitCode !== (plan.conflict ? 1 : 0)) throw new Error(result.stderr.trim() || "Could not prepare the pinned leaf merge");
    await this.assertPlannedMerge(cwd, plan);
  }

  /** Check the active merge identity while its admitted author may edit files. */
  async assertLeafMergeInProgress(cwd: string, branch: string, inputHead: string, targetCommit: string): Promise<void> {
    await this.assertWorktree(cwd, branch);
    if (await this.head(cwd) !== inputHead) throw new Error("Conflict author input HEAD changed; files were left untouched.");
    await this.assertExactCommit(cwd, targetCommit);
    await this.assertLeafParents(cwd, inputHead, [inputHead, targetCommit]);
  }

  async assertLeafMerge(cwd: string, branch: string, inputHead: string, targetCommit: string): Promise<void> {
    await this.assertLeafMergeInProgress(cwd, branch, inputHead, targetCommit);
    const snapshot = await this.readLeafMergeTree(cwd, "HEAD", targetCommit);
    if (!snapshot.conflict) throw new Error("Conflict author input is not the pinned conflict; files were left untouched.");
    await this.assertPlannedMerge(cwd, { inputHead, targetCommit, tree: snapshot.tree, conflict: true, contained: false });
  }

  private async leafTextBlob(cwd: string, text: string, write = false): Promise<string> {
    const result = await runCommand("git", ["hash-object", ...(write ? ["-w"] : []), "--stdin"], { cwd, input: text });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not identify managed progress text");
    return result.stdout.trim();
  }

  private async managedTreeFile(cwd: string, ref: string, path: string): Promise<ManagedTreeFile | null> {
    const result = await runCommand("git", ["ls-tree", "-z", ref, "--", path], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not inspect managed ${path}`);
    if (!result.stdout) return null;
    const entry = /^(100(?:644|755)) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(result.stdout);
    if (!entry || entry[3] !== path) throw new Error(`Managed ${path} is not a regular file; files were left untouched.`);
    const contents = await runCommand("git", ["cat-file", "blob", entry[2]!], { cwd });
    if (contents.exitCode !== 0 || await this.leafTextBlob(cwd, contents.stdout) !== entry[2]) {
      throw new Error(`Managed ${path} does not have exact UTF-8 text; files were left untouched.`);
    }
    return { mode: entry[1]!, blob: entry[2]!, text: contents.stdout };
  }

  private managedTemporary(inputHead: string, inputTree: string, file: Pick<LeafManagedPlan["files"][number], "path" | "oldBlob" | "text" | "mode">): string {
    const digest = createHash("sha256").update(JSON.stringify([inputHead, inputTree, file.path, file.oldBlob, file.text, file.mode])).digest("hex");
    return `${file.path}.burner-${digest}.tmp`;
  }

  private assertManagedReadme(oldText: string | null, text: string | null): void {
    const previous = progressReadmeBlock(oldText ?? "");
    const desired = progressReadmeBlock(text ?? "");
    if (text === oldText) return;
    const expected = replaceProgressReadmeBlock(oldText ?? "", desired?.text);
    if ((!previous && !desired) || (text !== expected && !(text === null && previous && expected === ""))) {
      throw new Error("Managed progress plan changes authored README bytes; files were left untouched.");
    }
  }

  private async treeWithManagedFiles(cwd: string, tree: string, files: Array<{ path: string; mode: string; text: string | null }>): Promise<string> {
    return this.withLeafIndex(cwd, tree, async (env) => {
      for (const file of files) {
        const args = file.text === null
          ? ["update-index", "--force-remove", "--", file.path]
          : ["update-index", "--add", "--cacheinfo", `${file.mode},${await this.leafTextBlob(cwd, file.text, true)},${file.path}`];
        const result = await runCommand("git", args, { cwd, env });
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not plan managed ${file.path}`);
      }
      const result = await runCommand("git", ["write-tree"], { cwd, env });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not identify the planned managed tree");
      return result.stdout.trim();
    });
  }

  private async validateManagedPlan(cwd: string, plan: LeafManagedPlan): Promise<Map<string, string | null>> {
    await this.assertExactCommit(cwd, plan.inputHead);
    if (await this.tree(plan.inputHead) !== plan.inputTree) throw new Error("Managed progress input tree does not match its saved commit.");
    const paths = new Set<string>();
    const desiredBlobs = new Map<string, string | null>();
    for (const file of plan.files) {
      if (!(MANAGED_PROGRESS_FILES as readonly string[]).includes(file.path) || paths.has(file.path) || (file.text !== null && typeof file.text !== "string")) {
        throw new Error("Managed progress plan contains an unexpected or repeated file; files were left untouched.");
      }
      paths.add(file.path);
      const old = await this.managedTreeFile(cwd, plan.inputHead, file.path);
      if ((old?.blob ?? null) !== file.oldBlob || (old?.text ?? null) !== file.oldText || (old?.mode ?? "100644") !== file.mode ||
        file.temporary !== this.managedTemporary(plan.inputHead, plan.inputTree, file)) {
        throw new Error(`Managed progress receipt does not match original ${file.path}; files were left untouched.`);
      }
      if (file.path === "README.md") this.assertManagedReadme(file.oldText, file.text);
      desiredBlobs.set(file.path, file.text === null ? null : await this.leafTextBlob(cwd, file.text));
    }
    if (await this.treeWithManagedFiles(cwd, plan.inputTree, plan.files) !== plan.tree) {
      throw new Error("Managed progress output tree does not match the exact saved transformation.");
    }
    return desiredBlobs;
  }

  private async managedWorktreeFile(cwd: string, path: string): Promise<{ text: string; mode: string } | null> {
    let current = cwd;
    const components = path.split("/");
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return null;
      if (index < components.length - 1) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unexpected managed parent ${path}; files were left untouched.`);
      } else {
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unexpected managed file ${path}; files were left untouched.`);
        const contents = await readFile(current);
        const text = contents.toString("utf8");
        if (!Buffer.from(text).equals(contents)) throw new Error(`Unexpected non-UTF-8 managed file ${path}; files were left untouched.`);
        return { text, mode: info.mode & 0o111 ? "100755" : "100644" };
      }
    }
    return null;
  }

  private managedFileMatches(actual: { text: string; mode: string } | null, text: string | null, mode: string): boolean {
    return text === null ? actual === null : actual?.text === text && actual.mode === mode;
  }

  private async assertManagedWorktree(cwd: string, plan: LeafManagedPlan, desiredBlobs: Map<string, string | null>, complete = false): Promise<void> {
    if (await this.head(cwd) !== plan.inputHead || (await this.leafMergeHeads(cwd)).length) {
      throw new Error("Managed progress requires its saved input head without another Git operation; files were left untouched.");
    }
    const [staged, unstaged, untracked, index] = await Promise.all([
      runCommand("git", ["diff", "--cached", "--name-only", "--no-renames", "-z", plan.inputHead, "--"], { cwd }),
      runCommand("git", ["diff", "--name-only", "--no-renames", "-z", "--"], { cwd }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd }),
      runCommand("git", ["ls-files", "--stage", "-z"], { cwd }),
    ]);
    if ([staged, unstaged, untracked, index].some((result) => result.exitCode !== 0)) throw new Error("Could not verify managed progress worktree state.");
    const paths = new Set(plan.files.map((file) => file.path));
    const temporaries = new Set(plan.files.map((file) => file.temporary));
    if ([...staged.stdout.split("\0"), ...unstaged.stdout.split("\0")].some((path) => path && !paths.has(path)) ||
      untracked.stdout.split("\0").some((path) => path && !paths.has(path) && !temporaries.has(path))) {
      throw new Error("Unexpected files outside the managed progress receipt; files were left untouched.");
    }
    const entries = new Map<string, { mode: string; blob: string }>();
    for (const line of index.stdout.split("\0").filter(Boolean)) {
      const entry = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(line);
      if (!entry || entry[3] !== "0") throw new Error("Unexpected conflicted index during managed progress; files were left untouched.");
      entries.set(entry[4]!, { mode: entry[1]!, blob: entry[2]! });
    }
    for (const file of plan.files) {
      const entry = entries.get(file.path);
      if ((entry?.blob ?? null) !== file.oldBlob && (entry?.blob ?? null) !== desiredBlobs.get(file.path) || entry && entry.mode !== file.mode) {
        throw new Error(`Unexpected staged managed file ${file.path}; files were left untouched.`);
      }
      const current = await this.managedWorktreeFile(cwd, file.path);
      if (!this.managedFileMatches(current, file.text, file.mode) && (complete || !this.managedFileMatches(current, file.oldText, file.mode))) {
        throw new Error(`Unexpected edits to managed ${file.path}; files were left untouched.`);
      }
      const temporary = await this.managedWorktreeFile(cwd, file.temporary);
      if (temporary && (complete || file.text === null || !this.managedFileMatches(temporary, file.text, file.mode))) {
        throw new Error(`Unexpected managed temporary ${file.temporary}; files were left untouched.`);
      }
    }
  }

  async planLeafManagedFiles(cwd: string, branch: string, inputHead: string, files: Record<string, string | null>): Promise<LeafManagedPlan> {
    await this.assertWorktree(cwd, branch);
    if (await this.head(cwd) !== inputHead || await this.hasChanges(cwd) || (await this.leafMergeHeads(cwd)).length) {
      throw new Error("Managed progress planning requires its clean saved input head; files were left untouched.");
    }
    const inputTree = await this.tree(inputHead);
    const planned: LeafManagedPlan["files"] = [];
    for (const path of Object.keys(files).sort()) {
      if (!(MANAGED_PROGRESS_FILES as readonly string[]).includes(path)) throw new Error(`Unexpected managed progress path '${path}'.`);
      const old = await this.managedTreeFile(cwd, inputHead, path);
      const file = { path, oldBlob: old?.blob ?? null, oldText: old?.text ?? null, mode: old?.mode ?? "100644", text: files[path]!, temporary: "" };
      if (!this.managedFileMatches(await this.managedWorktreeFile(cwd, path), file.oldText, file.mode)) {
        throw new Error(`Managed input ${path} differs from its saved commit; files were left untouched.`);
      }
      if (path === "README.md") this.assertManagedReadme(file.oldText, file.text);
      file.temporary = this.managedTemporary(inputHead, inputTree, file);
      planned.push(file);
    }
    const plan = { inputHead, inputTree, tree: await this.treeWithManagedFiles(cwd, inputTree, planned), files: planned };
    await this.assertManagedWorktree(cwd, plan, await this.validateManagedPlan(cwd, plan));
    return plan;
  }

  async applyLeafManagedFiles(cwd: string, branch: string, plan: LeafManagedPlan): Promise<void> {
    await this.assertWorktree(cwd, branch);
    const desiredBlobs = await this.validateManagedPlan(cwd, plan);
    await this.assertManagedWorktree(cwd, plan, desiredBlobs);
    for (const file of plan.files) {
      const current = await this.managedWorktreeFile(cwd, file.path);
      const temporary = await this.managedWorktreeFile(cwd, file.temporary);
      if (this.managedFileMatches(current, file.text, file.mode)) {
        if (temporary) await unlink(join(cwd, file.temporary));
        continue;
      }
      if (file.text === null) { await unlink(join(cwd, file.path)); continue; }
      await mkdir(dirname(join(cwd, file.path)), { recursive: true });
      if (!temporary) {
        await writeFile(join(cwd, file.temporary), file.text, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
        await chmod(join(cwd, file.temporary), file.mode === "100755" ? 0o755 : 0o644);
      }
      await rename(join(cwd, file.temporary), join(cwd, file.path));
    }
    await this.assertManagedWorktree(cwd, plan, desiredBlobs, true);
  }

  async verifyGeneratedProgress(certificate: GeneratedLeafProgress): Promise<void> {
    const { inputCommit, inputTree, outputCommit, outputTree, plan } = certificate;
    if (plan.inputHead !== inputCommit || plan.inputTree !== inputTree || plan.tree !== outputTree) {
      throw new Error("Generated progress certificate does not match its managed plan.");
    }
    await this.validateManagedPlan(this.root, plan);
    await this.assertExactCommit(this.root, outputCommit);
    if (await this.tree(outputCommit) !== outputTree) throw new Error("Generated progress output tree does not match its certificate.");
    if (inputTree === outputTree) {
      if (inputCommit !== outputCommit) throw new Error("A no-op progress certificate cannot authorize an extra commit.");
      return;
    }
    const parents = await runCommand("git", ["rev-list", "--parents", "-n", "1", outputCommit], { cwd: this.root });
    if (parents.exitCode !== 0 || parents.stdout.trim() !== `${outputCommit} ${inputCommit}`) {
      throw new Error("Generated progress commit does not match its exact parent receipt.");
    }
  }

  private reverseManagedReadme(file: LeafManagedPlan["files"][number], current: string | null): string | null {
    if (file.text === file.oldText) return current;
    if (current === file.text) return file.oldText;
    const before = progressReadmeBlock(file.oldText ?? "");
    const after = progressReadmeBlock(file.text ?? "");
    const inherited = progressReadmeBlock(current ?? "");
    if (after && inherited?.text === after.text && current !== null) {
      if (before) return replaceProgressReadmeBlock(current, before.text);
      // A newly appended block also owns its exact inserted separator/newline,
      // not the pre-existing whitespace or later authored README content.
      const separator = file.text!.slice((file.oldText ?? "").length, after.start);
      const suffix = file.text!.slice(after.end);
      const prefix = current.slice(0, inherited.start);
      const tail = current.slice(inherited.end);
      if (prefix.endsWith(separator) && tail.startsWith(suffix)) {
        const restored = prefix.slice(0, prefix.length - separator.length) + tail.slice(suffix.length);
        return file.oldText === null && !restored ? null : restored;
      }
    }
    throw new Error("The inherited managed README transformation cannot be reversed exactly.");
  }

  private managedProgressMatches(path: string, expected: ManagedTreeFile | null, current: ManagedTreeFile | null): boolean {
    return path === "README.md"
      ? progressReadmeBlock(expected?.text ?? "")?.text === progressReadmeBlock(current?.text ?? "")?.text && (!expected || current?.mode === expected.mode)
      : expected?.blob === current?.blob && expected?.mode === current?.mode;
  }

  /** Only the tree changes while reversing a chain; ancestry stays commit-valued. */
  private async reverseLeafProgressTree(tree: string, certificate: GeneratedLeafProgress): Promise<string> {
    const currentFiles = new Map<string, ManagedTreeFile | null>();
    for (const path of MANAGED_PROGRESS_FILES) {
      const [expected, current] = await Promise.all([
        this.managedTreeFile(this.root, certificate.outputTree, path),
        this.managedTreeFile(this.root, tree, path),
      ]);
      currentFiles.set(path, current);
      if (!this.managedProgressMatches(path, expected, current)) throw new Error(`Candidate changed inherited certified managed ${path}.`);
    }
    const reversed = certificate.plan.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      text: file.path === "README.md" ? this.reverseManagedReadme(file, currentFiles.get(file.path)?.text ?? null) : file.oldText,
    }));
    return this.treeWithManagedFiles(this.root, tree, reversed);
  }

  /** Compare implementation trees without granting descendants inherited approval. */
  async normalizeLeafProgressTree(head: string, certificate: GeneratedLeafProgress): Promise<string> {
    await this.verifyGeneratedProgress(certificate);
    await this.assertExactCommit(this.root, head);
    if (!await this.isAncestor(this.root, certificate.outputCommit, head)) {
      throw new Error("Candidate does not descend from the certified progress commit.");
    }
    return this.reverseLeafProgressTree(await this.tree(head), certificate);
  }

  private async validateLeafProgressHistory(baseCommit: string, certificates: readonly GeneratedLeafProgress[]): Promise<{
    flattened: GeneratedLeafProgress[];
    signatures: Map<GeneratedLeafProgress, string>;
  }> {
    await this.assertExactCommit(this.root, baseCommit);
    if (!Array.isArray(certificates)) throw new Error("Generated progress history requires certificate roots.");
    const flattened: GeneratedLeafProgress[] = [];
    const visited = new Set<GeneratedLeafProgress>();
    const active = new Set<GeneratedLeafProgress>();
    const heights = new Map<GeneratedLeafProgress, number>();
    // Refuse excessive proof nesting; never truncate retained rejection memory.
    // Iterative traversal also bounds malformed input without using the JS stack.
    const maximumDepth = 256;
    for (const root of certificates) {
      const pending: Array<{ certificate: GeneratedLeafProgress; depth: number; exiting: boolean }> = [{ certificate: root, depth: 0, exiting: false }];
      while (pending.length) {
        const { certificate, depth, exiting } = pending.pop()!;
        if (!certificate || typeof certificate !== "object" || !certificate.plan || !Array.isArray(certificate.plan.files) ||
          certificate.previous !== undefined && !Array.isArray(certificate.previous)) {
          throw new Error("Malformed generated progress history certificate.");
        }
        if (exiting) {
          const height = (certificate.previous ?? []).reduce((maximum: number, previous: GeneratedLeafProgress) => Math.max(maximum, 1 + heights.get(previous)!), 0);
          heights.set(certificate, height);
          active.delete(certificate);
          visited.add(certificate);
          flattened.push(certificate);
          continue;
        }
        if (active.has(certificate)) throw new Error("Generated progress history contains a cyclic predecessor proof.");
        if (depth + (heights.get(certificate) ?? 0) > maximumDepth) {
          throw new Error(`Generated progress predecessor depth exceeds ${maximumDepth}; retained proofs were left untouched.`);
        }
        if (visited.has(certificate)) continue;
        active.add(certificate);
        pending.push({ certificate, depth, exiting: true });
        for (const previous of [...(certificate.previous ?? [])].reverse()) pending.push({ certificate: previous, depth: depth + 1, exiting: false });
      }
    }

    const signatures = new Map<GeneratedLeafProgress, string>();
    const transformations = new Map<string, string>();
    for (const certificate of flattened) {
      if (certificate.baseCommit !== undefined && certificate.baseCommit !== baseCommit) {
        throw new Error("Generated progress certificate belongs to another comparison base.");
      }
      await this.verifyGeneratedProgress(certificate);
      for (const previous of certificate.previous ?? []) {
        if (!await this.isAncestor(this.root, previous.outputCommit, certificate.inputCommit)) {
          throw new Error("Generated progress predecessor does not precede the certificate input.");
        }
      }
      if (!await this.isAncestor(this.root, baseCommit, certificate.inputCommit)) {
        throw new Error("Generated progress input does not descend from the recorded comparison base.");
      }
      const { plan } = certificate;
      const signature = createHash("sha256").update(JSON.stringify([
        certificate.baseCommit ?? null, certificate.inputCommit, certificate.inputTree, certificate.outputCommit, certificate.outputTree,
        plan.inputHead, plan.inputTree, plan.tree,
        [...plan.files].sort((left, right) => left.path.localeCompare(right.path)).map((file) => [file.path, file.oldBlob, file.oldText, file.text, file.mode, file.temporary]),
        [...new Set((certificate.previous ?? []).map((previous) => signatures.get(previous)!))].sort(),
      ])).digest("hex");
      signatures.set(certificate, signature);
      if (certificate.inputTree !== certificate.outputTree) {
        const previous = transformations.get(certificate.outputCommit);
        if (previous !== undefined && previous !== signature) throw new Error("Conflicting generated progress certificate provenance for one output commit.");
        transformations.set(certificate.outputCommit, signature);
      }
    }
    return { flattened, signatures };
  }

  /** Validate all retained proofs before omitting exact embedded/duplicate roots. */
  async compactLeafProgressHistory(baseCommit: string, certificates: readonly GeneratedLeafProgress[]): Promise<GeneratedLeafProgress[]> {
    const { flattened, signatures } = await this.validateLeafProgressHistory(baseCommit, certificates);
    const embedded = new Set(flattened.flatMap((certificate) => (certificate.previous ?? []).map((previous) => signatures.get(previous)!)));
    const retained = new Set<string>();
    const frontier = certificates.filter((certificate) => {
      const signature = signatures.get(certificate)!;
      if (embedded.has(signature) || retained.has(signature)) return false;
      retained.add(signature);
      return true;
    });
    // Establish legacy old-base compatibility and composability for each root,
    // including valid independent roots not applicable to the current head.
    for (const certificate of frontier) await this.normalizeVerifiedLeafProgressHistoryTree(certificate.outputCommit, baseCommit, flattened);
    return frontier;
  }

  private async normalizeVerifiedLeafProgressHistoryTree(commit: string, baseCommit: string, flattened: readonly GeneratedLeafProgress[]): Promise<string> {
    const applicable = new Map<string, GeneratedLeafProgress>();
    let needsLegacyBaseProof = false;
    for (const certificate of flattened) {
      if (!await this.isAncestor(this.root, certificate.outputCommit, commit)) continue;
      if (certificate.inputTree === certificate.outputTree) continue;
      needsLegacyBaseProof ||= certificate.baseCommit === undefined;
      // Every duplicate is verified above; one commit's exact parent/tree effect
      // is reversed once, even when several retained roots share its proof.
      applicable.set(certificate.outputCommit, certificate);
    }
    let tree = await this.tree(commit);
    if (!applicable.size) return tree;
    const ancestry = await runCommand("git", ["rev-list", "--topo-order", commit, `^${baseCommit}`], { cwd: this.root });
    if (ancestry.exitCode !== 0) throw new Error(ancestry.stderr.trim() || "Could not order generated progress ancestry");
    const ordered = ancestry.stdout.trim().split("\n").map((head) => applicable.get(head)).filter((item): item is GeneratedLeafProgress => item !== undefined);
    if (ordered.length !== applicable.size) throw new Error("Could not establish every applicable generated progress ancestor.");
    for (const [index, certificate] of ordered.entries()) {
      const newer = ordered[index - 1];
      if (newer && !await this.isAncestor(this.root, certificate.outputCommit, newer.inputCommit)) {
        throw new Error("Generated progress history does not form one ancestral transformation chain.");
      }
      tree = await this.reverseLeafProgressTree(tree, certificate);
    }
    if (needsLegacyBaseProof) {
      for (const path of MANAGED_PROGRESS_FILES) {
        const [expected, current] = await Promise.all([
          this.managedTreeFile(this.root, baseCommit, path),
          this.managedTreeFile(this.root, tree, path),
        ]);
        if (!this.managedProgressMatches(path, expected, current)) {
          throw new Error(`Legacy progress history cannot establish exact old-base managed ${path}.`);
        }
      }
    }
    return tree;
  }

  /** Restore only proved generated transformations for one recorded comparison base. */
  async normalizeLeafProgressHistoryTree(commit: string, baseCommit: string, certificates: readonly GeneratedLeafProgress[]): Promise<string> {
    if (!await this.isCommitAncestor(baseCommit, commit)) throw new Error("History candidate does not descend from its recorded comparison base.");
    const { flattened } = await this.validateLeafProgressHistory(baseCommit, certificates);
    return this.normalizeVerifiedLeafProgressHistoryTree(commit, baseCommit, flattened);
  }

  async commit(cwd: string, message: string): Promise<string> {
    const add = await runCommand("git", ["add", "-A"], { cwd });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not stage changes");
    const commit = await runCommand(
      "git",
      ["-c", "user.name=Burner", "-c", "user.email=burner@localhost", "commit", "-m", message],
      { cwd },
    );
    if (commit.exitCode !== 0) throw new Error(commit.stderr.trim() || "Could not commit changes");
    return this.head(cwd);
  }

  async push(cwd: string, remote: string, branch: string): Promise<void> {
    // Pin both refs: source-only pushes can inherit upstream destinations and forced remote mappings.
    const fullBranch = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    const result = await runCommand("git", ["push", "-u", remote, `${fullBranch}:${fullBranch}`], { cwd, timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not push branch");
  }

  async remoteBranchHead(cwd: string, remote: string, branch: string): Promise<string | null> {
    const destination = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    const valid = await runCommand("git", ["check-ref-format", destination], { cwd });
    if (valid.exitCode !== 0) throw new Error(`Invalid leaf branch '${branch}'.`);
    const result = await runCommand("git", ["ls-remote", "--heads", remote, destination], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not inspect the published leaf branch");
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (!lines.length) return null;
    const [head, ref] = lines[0]!.split(/\s+/);
    if (lines.length !== 1 || ref !== destination || !head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) {
      throw new Error("The published leaf branch did not have one exact remote head.");
    }
    return head;
  }

  /** A receipt's saved lease is authority; a freshly observed third head is not. */
  async pushLeaf(cwd: string, remote: string, branch: string, desiredHead: string, savedExpectedRemoteHead: string | null): Promise<void> {
    await this.assertWorktree(cwd, branch);
    if (await this.head(cwd) !== desiredHead || await this.hasChanges(cwd) || (await this.leafMergeHeads(cwd)).length) {
      throw new Error("Leaf publication requires its exact clean saved head; files were left untouched.");
    }
    const observed = await this.remoteBranchHead(cwd, remote, branch);
    if (observed === desiredHead) return;
    if (observed !== savedExpectedRemoteHead) {
      throw new Error("Published leaf head changed from the saved remote lease; the remote branch was left untouched.");
    }
    if (observed !== null && !await this.isAncestor(cwd, observed, desiredHead)) {
      throw new Error("Leaf publication would discard published history; the remote branch was left untouched.");
    }
    const destination = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    // Pin the source SHA as well as the destination lease. A branch movement
    // during the command must never publish a different, unreceipted commit.
    const result = await runCommand("git", [
      "push", `--force-with-lease=${destination}:${savedExpectedRemoteHead ?? ""}`, remote, `${desiredHead}:${destination}`,
    ], { cwd, timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not publish the saved leaf head");
    await this.assertWorktree(cwd, branch);
    if (await this.head(cwd) !== desiredHead || await this.remoteBranchHead(cwd, remote, branch) !== desiredHead) {
      throw new Error("Leaf publication changed before acknowledgement; the saved receipt remains pending.");
    }
  }

  async forcePush(cwd: string, remote: string, branch: string): Promise<void> {
    const destination = `refs/heads/${branch}`;
    const remoteHead = await runCommand("git", ["ls-remote", "--heads", remote, destination], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (remoteHead.exitCode !== 0) throw new Error(remoteHead.stderr.trim() || "Could not inspect composite branch before updating it");
    const expected = remoteHead.stdout.trim().split(/\s+/)[0] ?? "";
    const result = await runCommand(
      "git",
      ["push", `--force-with-lease=${destination}:${expected}`, "-u", remote, `${destination}:${destination}`],
      { cwd, timeoutMs: GIT_PUSH_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not update composite branch");
  }

  async pushCheckpoint(cwd: string, remote: string, checkpointBranch: string): Promise<void> {
    const result = await runCommand("git", ["push", "--force", remote, `HEAD:refs/heads/${checkpointBranch}`], { cwd, timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not persist the living-line checkpoint");
  }

  async openPr(options: {
    cwd: string;
    base: string;
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number?: number }> {
    const args = ["pr", "create", "--base", options.base, "--head", options.branch, "--title", options.title, "--body", options.body];
    if (options.draft) args.push("--draft");
    const result = await runCommand(
      "gh",
      args,
      { cwd: options.cwd, timeoutMs: 5 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not open pull request");
    const url = result.stdout.trim().split("\n").at(-1) ?? "";
    const match = url.match(/\/pull\/(\d+)/);
    const number = match ? Number(match[1]) : undefined;
    if (number) await this.markPrDisposition(options.cwd, number, "unmerged").catch(() => undefined);
    return { url, number };
  }

  async removeWorktree(path: string): Promise<void> {
    await runCommand("git", ["worktree", "remove", "--force", path], { cwd: this.root });
  }

  async editPr(cwd: string, number: number, title: string, body: string): Promise<void> {
    const result = await runCommand("gh", ["pr", "edit", String(number), "--title", title, "--body", body], { cwd, timeoutMs: 5 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not update PR #${number}`);
  }

  async markPrReady(cwd: string, number: number): Promise<void> {
    const result = await runCommand("gh", ["pr", "ready", String(number)], { cwd, timeoutMs: 2 * 60 * 1000 });
    const stderr = result.stderr.toLowerCase();
    if (result.exitCode !== 0 && !stderr.includes("already marked ready") && !stderr.includes("not a draft")) {
      throw new Error(result.stderr.trim() || `Could not mark PR #${number} ready`);
    }
  }

  async markPrDraft(cwd: string, number: number): Promise<void> {
    const result = await runCommand("gh", ["pr", "ready", String(number), "--undo"], { cwd, timeoutMs: 2 * 60 * 1000 });
    const stderr = result.stderr.toLowerCase();
    if (result.exitCode !== 0 && !stderr.includes("already a draft") && !stderr.includes("is a draft")) {
      throw new Error(result.stderr.trim() || `Could not mark PR #${number} as draft`);
    }
  }

  async isPrDraft(cwd: string, number: number): Promise<boolean> {
    const pullRequest = await this.githubJson<{ isDraft: boolean }>(
      cwd,
      ["pr", "view", String(number), "--json", "isDraft"],
      `inspect draft state for PR #${number}`,
    );
    return pullRequest.isDraft;
  }

  async pullRequestsForBranch(cwd: string, branch: string): Promise<PullRequestSummary[]> {
    return this.githubJson<PullRequestSummary[]>(cwd, ["pr", "list", "--head", branch, "--state", "all", "--limit", "10", "--json", "number,state,headRefName,headRefOid,url,title,body,isDraft,statusCheckRollup"], `inspect PRs for ${branch}`);
  }

  async getPullRequest(cwd: string, number: number): Promise<PullRequestSummary> {
    return this.githubJson<PullRequestSummary>(
      cwd,
      ["pr", "view", String(number), "--json", "number,state,headRefName,headRefOid,url,title,body,isDraft,statusCheckRollup"],
      `inspect exact identity for PR #${number}`,
    );
  }

  async changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
    const result = await runCommand("git", ["diff", "--name-only", `${base}...${head}`], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not compare ${base} and ${head}`);
    return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  }

  async closePr(cwd: string, number: number, comment: string, disposition: PullRequestDisposition = "unmerged"): Promise<void> {
    const result = await runCommand("gh", ["pr", "close", String(number), "--comment", comment], { cwd, timeoutMs: 5 * 60 * 1000 });
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const alreadyClosed = output.includes("already closed");
    const alreadyMerged = output.includes("already merged");
    if (result.exitCode !== 0 && !alreadyClosed && !alreadyMerged) throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not close PR #${number}`);
    // GitHub can automatically mark a source PR merged when a composite that
    // contains its exact commits lands. Treat that race as an idempotent close
    // and retain the authoritative merged disposition instead of aborting the
    // remaining source reconciliation.
    await this.markPrDisposition(cwd, number, alreadyMerged ? "merged" : disposition).catch(() => undefined);
  }

  async reopenPr(cwd: string, number: number): Promise<void> {
    const current = await this.githubJson<{ state: "OPEN" | "CLOSED" | "MERGED" }>(
      cwd,
      ["pr", "view", String(number), "--json", "state"],
      `inspect PR #${number} before retry`,
    );
    if (current.state === "MERGED") throw new Error(`Cannot retry merged PR #${number}.`);
    if (current.state === "CLOSED") {
      const result = await runCommand("gh", ["pr", "reopen", String(number)], { cwd, timeoutMs: 2 * 60 * 1000 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not reopen PR #${number}`);
    }
    await this.markPrDisposition(cwd, number, "unmerged").catch(() => undefined);
  }

  async mergePr(cwd: string, number: number, expectedHead: string): Promise<void> {
    if (!expectedHead.trim()) throw new Error(`Cannot merge PR #${number} without its exact pushed head commit.`);
    const mergeAttempts = this.mergePolling.mergeAttempts ?? 24;
    let lastError = "";
    for (let attempt = 1; attempt <= mergeAttempts; attempt += 1) {
      const status = await this.waitForPrMergeability(cwd, number, expectedHead);
      if (status.state === "MERGED") {
        await this.markPrDisposition(cwd, number, "merged").catch(() => undefined);
        return;
      }
      await this.waitForPrChecks(cwd, number, expectedHead);
      // An explicit merge request also authorizes publishing its checked draft.
      // Automatic scheduling still leaves owner-gated drafts alone before it
      // reaches this method. Recheck identity before changing publication state.
      const publication = await this.githubJson<{ state: "OPEN" | "CLOSED" | "MERGED"; headRefOid: string; isDraft: boolean }>(
        cwd,
        ["pr", "view", String(number), "--json", "state,headRefOid,isDraft"],
        `inspect PR #${number} before publication`,
      );
      if (publication.state === "MERGED") {
        await this.markPrDisposition(cwd, number, "merged").catch(() => undefined);
        return;
      }
      if (publication.state !== "OPEN" || publication.headRefOid !== expectedHead) {
        throw new TransientMergeGateError(`PR #${number} changed before publication; expected open head ${expectedHead.slice(0, 8)}.`);
      }
      if (publication.isDraft) {
        await this.markPrReady(cwd, number);
        // Publishing can trigger additional checks. Preserve the exact-head
        // gate, and pin the final mutation against a later concurrent push.
        await this.waitForPrChecks(cwd, number, expectedHead);
      }
      const result = await runCommand("gh", ["pr", "merge", String(number), "--merge", "--match-head-commit", expectedHead], { cwd, timeoutMs: 10 * 60 * 1000 });
      if (result.exitCode === 0) {
        await this.markPrDisposition(cwd, number, "merged").catch(() => undefined);
        return;
      }
      lastError = result.stderr.trim() || result.stdout.trim() || `Could not merge PR #${number}`;
      const transientState = /not mergeable|mergeability|pull request.*(?:not open|closed)|head (?:branch|sha).*(?:changed|updated)|base branch.*(?:changed|updated)/i.test(lastError);
      const transientTransport = isTransientGitHubFailure(lastError);
      if (!transientState && !transientTransport) throw new Error(lastError);
      if (attempt === mergeAttempts) throw new TransientMergeGateError(lastError);
      await wait(this.mergePolling.intervalMs ?? 2_500);
    }
    throw new Error(lastError || `Could not merge PR #${number}`);
  }

  private async waitForPrChecks(cwd: string, number: number, expectedHead: string): Promise<void> {
    // A release-wheel build plus a full compatibility suite can exceed the
    // old five-minute polling budget. Keep waiting bounded without relaxing
    // the exact-head or terminal-failure gates below.
    const attempts = this.mergePolling.checkAttempts ?? 360;
    const noCheckGraceAttempts = Math.min(attempts, this.mergePolling.noCheckGraceAttempts ?? 4);
    const intervalMs = this.mergePolling.intervalMs ?? 2_500;
    let lastPending: string[] = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const status = await this.githubJson<PullRequestCheckStatus>(
        cwd,
        ["pr", "view", String(number), "--json", "state,headRefOid,statusCheckRollup"],
        `inspect PR #${number} checks`,
      );
      if (status.state === "MERGED") return;
      if (status.state === "CLOSED" && status.headRefOid === expectedHead) {
        await this.reopenExactPr(cwd, number, expectedHead);
        if (attempt < attempts) { await wait(intervalMs); continue; }
      }
      if (status.state !== "OPEN") throw new Error(`PR #${number} is ${status.state.toLowerCase()} instead of open.`);
      if (status.headRefOid !== expectedHead) {
        if (attempt < attempts) { await wait(intervalMs); continue; }
        throw new Error(`PR #${number} checks never observed expected head ${expectedHead.slice(0, 8)} (observed ${status.headRefOid?.slice(0, 8) || "unknown"}).`);
      }
      const checks = status.statusCheckRollup ?? [];
      if (!checks.length) {
        if (attempt >= noCheckGraceAttempts) return;
        await wait(intervalMs);
        continue;
      }
      const failures: string[] = [];
      const pending: string[] = [];
      for (const check of checks) {
        const name = check.name ?? check.context ?? check.__typename ?? "unnamed check";
        const outcome = String(check.conclusion ?? check.state ?? "").toUpperCase();
        const execution = String(check.status ?? "").toUpperCase();
        if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome)) continue;
        if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(outcome)) failures.push(name);
        else if (execution === "COMPLETED") failures.push(name);
        else pending.push(name);
      }
      if (failures.length) throw new Error(`PR #${number} required check${failures.length === 1 ? "" : "s"} failed at ${expectedHead.slice(0, 8)}: ${failures.join(", ")}. Burner will not merge a failing head.`);
      if (!pending.length) return;
      lastPending = pending;
      if (attempt < attempts) await wait(intervalMs);
    }
    throw new TransientMergeGateError(`PR #${number} checks did not finish at ${expectedHead.slice(0, 8)}: ${lastPending.join(", ") || "status unavailable"}.`);
  }

  private async waitForPrMergeability(cwd: string, number: number, expectedHead: string): Promise<PullRequestMergeStatus> {
    const attempts = this.mergePolling.attempts ?? 24;
    const intervalMs = this.mergePolling.intervalMs ?? 2_500;
    let lastStatus: PullRequestMergeStatus | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      lastStatus = await this.githubJson<PullRequestMergeStatus>(
        cwd,
        ["pr", "view", String(number), "--json", "state,mergeable,headRefOid"],
        `inspect PR #${number} mergeability`,
      );
      if (lastStatus.state === "MERGED") return lastStatus;
      if (lastStatus.state === "CLOSED" && lastStatus.headRefOid === expectedHead) {
        await this.reopenExactPr(cwd, number, expectedHead);
        if (attempt < attempts) { await wait(intervalMs); continue; }
      }
      if (lastStatus.state !== "OPEN") throw new Error(`PR #${number} is ${lastStatus.state.toLowerCase()} instead of open.`);
      if (lastStatus.headRefOid === expectedHead && lastStatus.mergeable === "MERGEABLE") return lastStatus;
      if (lastStatus.headRefOid === expectedHead && lastStatus.mergeable === "CONFLICTING") {
        throw new Error(`PR #${number} conflicts with its base branch at ${expectedHead.slice(0, 8)}.`);
      }
      // GitHub can leave the GraphQL mergeability field UNKNOWN even after the
      // exact head's required checks have succeeded. The merge mutation is the
      // authoritative answer in that state, and mergePr retries its transient
      // "not mergeable" responses without ever relaxing the exact-head/check
      // gates. Do not permanently retire a validated head just because this
      // advisory field is stale.
      if (lastStatus.headRefOid === expectedHead && lastStatus.mergeable === "UNKNOWN") return lastStatus;
      if (attempt < attempts) await wait(intervalMs);
    }
    const observed = lastStatus?.headRefOid ? lastStatus.headRefOid.slice(0, 8) : "unknown";
    throw new Error(`GitHub did not report PR #${number} mergeable at head ${expectedHead.slice(0, 8)} after ${attempts} checks (observed ${observed}, ${lastStatus?.mergeable ?? "UNKNOWN"}).`);
  }

  private async reopenExactPr(cwd: string, number: number, expectedHead: string): Promise<void> {
    const result = await runCommand("gh", ["pr", "reopen", String(number)], { cwd, timeoutMs: 2 * 60 * 1000 });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Could not reopen externally closed PR #${number} at validated head ${expectedHead.slice(0, 8)}.`);
    }
  }

  async markPrDisposition(cwd: string, number: number, disposition: PullRequestDisposition): Promise<void> {
    await this.ensureDispositionLabels(cwd);
    const desired = `burner-${disposition}`;
    const opposite = disposition === "merged" ? "burner-unmerged" : "burner-merged";
    const args = ["pr", "edit", String(number), "--add-label", desired, "--remove-label", opposite];
    if (disposition === "merged") args.push("--remove-label", "burner-quarantined");
    const result = await runCommand(
      "gh",
      args,
      { cwd, timeoutMs: 2 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not label PR #${number} as ${disposition}`);
  }

  async markPrQuarantined(cwd: string, number: number): Promise<void> {
    await this.ensureDispositionLabels(cwd);
    const result = await runCommand(
      "gh",
      ["pr", "edit", String(number), "--add-label", "burner-quarantined"],
      { cwd, timeoutMs: 2 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not quarantine PR #${number}`);
  }

  private async ensureDispositionLabels(cwd: string): Promise<void> {
    if (this.dispositionLabelsReady) return;
    const labels = [
      ["burner-merged", "1f883d", "Merged directly or included through a merged Burner composite"],
      ["burner-unmerged", "d97706", "Open or closed without inclusion in main"],
      ["burner-quarantined", "cf222e", "Removed from an autonomous batch after exhausting its review budget"],
    ] as const;
    for (const [name, color, description] of labels) {
      const result = await runCommand(
        "gh",
        ["label", "create", name, "--color", color, "--description", description, "--force"],
        { cwd, timeoutMs: 2 * 60 * 1000 },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not create GitHub label '${name}'`);
    }
    this.dispositionLabelsReady = true;
  }

  async listPullRequests(cwd = this.root): Promise<PullRequestSummary[]> {
    const [allResult, openResult] = await Promise.all([
      runCommand("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName,url,labels"], { cwd, timeoutMs: 2 * 60 * 1000 }),
      runCommand("gh", ["pr", "list", "--state", "open", "--limit", "1000", "--json", "number,headRefOid,statusCheckRollup"], { cwd, timeoutMs: 2 * 60 * 1000 }),
    ]);
    if (allResult.exitCode !== 0) throw new Error(allResult.stderr.trim() || "Could not synchronize pull requests");
    if (openResult.exitCode !== 0) throw new Error(openResult.stderr.trim() || "Could not synchronize open pull request checks");
    const pullRequests = JSON.parse(allResult.stdout) as PullRequestSummary[];
    const openDetails = JSON.parse(openResult.stdout) as Array<Pick<PullRequestSummary, "number" | "headRefOid" | "statusCheckRollup">>;
    const openByNumber = new Map(openDetails.map((pr) => [pr.number, pr]));
    return pullRequests.map((pr) => ({ ...pr, ...openByNumber.get(pr.number) }));
  }

  async syncBase(remote: string, baseBranch: string): Promise<string> {
    const fetch = await runCommand("git", ["fetch", remote, baseBranch], { cwd: this.root, timeoutMs: 10 * 60 * 1000 });
    if (fetch.exitCode !== 0) throw new Error(fetch.stderr.trim() || `Could not fetch ${remote}/${baseBranch}`);
    const status = await this.status();
    if (status.dirty) throw new Error("Cannot update the base branch while the root checkout has uncommitted changes.");
    if (status.branch !== baseBranch) throw new Error(`Switch the root checkout to '${baseBranch}' so Burner can fast-forward after merges.`);
    const merge = await runCommand("git", ["merge", "--ff-only", `${remote}/${baseBranch}`], { cwd: this.root });
    if (merge.exitCode !== 0) throw new Error(merge.stderr.trim() || `Could not fast-forward ${baseBranch}`);
    return this.head();
  }

  async remoteExists(remote: string): Promise<boolean> {
    return (await runCommand("git", ["remote", "get-url", remote], { cwd: this.root })).exitCode === 0;
  }
}

/** Identifies only the established writer functions, not the surrounding module. */
export function leafPrRendererFingerprint(): string {
  return createHash("sha256").update(JSON.stringify([reviewSection.toString(), evaluationRows.toString(), buildPrBody.toString()])).digest("hex");
}

function reviewSection(reviewRounds: ReviewRound[]): string[] {
  const approved = reviewRounds.at(-1)?.approved;
  return [
    "## Review loop",
    "",
    approved ? `✅ Approved by an independent Codex reviewer after ${reviewRounds.length} round${reviewRounds.length === 1 ? "" : "s"}.` : "⚠️ Review approval was not recorded.",
    "",
    ...reviewRounds.map((round) => `- Round ${round.round}: ${round.approved ? "approved" : `${round.findings.length} finding${round.findings.length === 1 ? "" : "s"}`}`),
    "",
  ];
}

function evaluationRows(deltas: ScoreDelta[]): string {
  return deltas.length
    ? deltas.map((delta) => {
        const before = delta.before === undefined ? "—" : delta.before.toFixed(1);
        const after = delta.after === undefined ? "—" : delta.after.toFixed(1);
        const change = delta.delta === undefined ? "—" : `${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(1)}`;
        const name = `${delta.name}${delta.screening ? " (leaf screen)" : ""}`;
        return `| ${name.replace(/\|/g, "\\|")} | ${before} | ${after} | ${change} |`;
      }).join("\n")
    : "| No completed evaluations | — | — | — |";
}

export function buildPrBody(description: string, lastMessage: string, deltas: ScoreDelta[], impact: number, reviewRounds: ReviewRound[] = []): string {
  const rows = evaluationRows(deltas);
  return [
    "## What changed",
    "",
    description,
    "",
    lastMessage,
    "",
    ...reviewSection(reviewRounds),
    "## Evaluation impact",
    "",
    `**Burner impact score: ${impact >= 0 ? "+" : ""}${impact.toFixed(1)}**`,
    "",
    "| Evaluation | Before | After | Delta |",
    "| --- | ---: | ---: | ---: |",
    rows,
    "",
    deltas.some((delta) => delta.screening)
      ? "<sub>Leaf-screen commands are compared with the same screen on the base. Composite PRs rerun each full command on the combined checkout before merging.</sub>"
      : "<sub>Generated and evaluated locally by Burner. Scores are model-based signals; review the code and evidence before merging.</sub>",
  ].join("\n");
}

export function buildCompositePrBody(options: { description: string; sources: CompositeSource[]; deltas: ScoreDelta[]; compositeScore: number; impact: number; reviewRounds: ReviewRound[] }): string {
  const visibleSources = options.sources.slice(-100);
  const omittedSources = options.sources.length - visibleSources.length;
  return [
    "## Master cook",
    "",
    options.description,
    "",
    `This living composite was built and evaluated from the actual combined code for ${options.sources.length} constituent changes:`,
    "",
    ...(omittedSources ? [`- … ${omittedSources} earlier constituent changes retained in the living line`] : []),
    ...visibleSources.map((source) => source.prNumber ? `- #${source.prNumber} — ${source.title}` : `- 🧪 ${source.title} — absorbed experiment${source.impact === undefined ? "" : ` (${source.impact >= 0 ? "+" : ""}${source.impact.toFixed(1)})`}`),
    "",
    ...reviewSection(options.reviewRounds),
    "## Recalculated composite evaluation",
    "",
    `**Composite score: ${options.compositeScore.toFixed(1)} / 100** · **Impact: ${options.impact >= 0 ? "+" : ""}${options.impact.toFixed(1)}**`,
    "",
    "| Evaluation | Base | Composite | Delta |",
    "| --- | ---: | ---: | ---: |",
    evaluationRows(options.deltas),
    "",
    "Burner continuously updates this feature branch with approved, regression-free experiments. Merging it closes included source PRs and rebuilds every other open composite against the new base.",
    "",
    "<sub>Composite scores are recalculated from the combined worktree, never inferred by adding individual deltas.</sub>",
  ].join("\n");
}

export function buildCompositeDraftPrBody(options: { description: string; sources: CompositeSource[]; reviewRounds?: ReviewRound[]; phase: string }): string {
  return [
    "## Master cook · draft",
    "",
    options.description,
    "",
    `🚧 **Burner is ${options.phase}.** This PR is visible early for auditability but is not mergeable until independent review and combined-code evaluation finish.`,
    "",
    "## Constituent changes",
    "",
    ...options.sources.map((source) => source.prNumber ? `- #${source.prNumber} — ${source.title}` : `- 🧪 ${source.title}`),
    "",
    ...(options.reviewRounds?.length ? reviewSection(options.reviewRounds) : []),
    "## Recalculated composite evaluation",
    "",
    "Pending. Burner will replace this section with scores measured from the actual combined checkout, then mark the PR ready.",
    "",
    "<sub>Draft opened early by Burner so integration and review progress is visible on GitHub.</sub>",
  ].join("\n");
}
