import assert from "node:assert/strict";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GitService } from "../dist/lib/git.js";
import { fullMergeValidationFingerprint } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureLeafPr } from "./leaf-pr-test-helpers.js";

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const sandbox = await mkdtemp(join(tmpdir(), "burner-leaf-receipt-test-"));
  const root = join(sandbox, "project");
  await mkdir(root);
  await mkdir(join(sandbox, "tmp"));
  let passed = false;
  t.after(async () => {
    if (passed) await rm(sandbox, { recursive: true, force: true });
    else t.diagnostic(`Failed isolated Git/CLI fixture retained: ${sandbox}`);
  });
  await gitCommand(root, "init", "-b", "main");
  await writeFile(join(root, ".gitignore"), ".burner/\ntarget/\n");
  await writeFile(join(root, "code.txt"), "base\n");
  const git = new GitService(root, join(root, ".burner"));
  const base = await git.commit(root, "base");
  const worktree = await git.createWorktree("agent", "burner/receipt", "main");
  return { sandbox, root, git, base, worktree, pass: () => { passed = true; } };
}

test("real Git prepares a staged-tree receipt and recognizes commit-before-StateStore interruption", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.worktree, "code.txt"), "implementation\n");
  await writeFile(join(f.worktree, "new.txt"), "new implementation\n");
  await mkdir(join(f.worktree, "target"));
  await writeFile(join(f.worktree, "target", "historical.json"), '{"measured":true}\n');
  const prepared = await f.git.prepareLeafCommit(f.worktree, "burner/receipt", f.base);
  assert.equal(await f.git.head(f.worktree), f.base, "preparation must not commit");
  assert.equal(prepared.tree, await gitCommand(f.worktree, "write-tree"));
  const store = new StateStore(f.root);
  await store.init();
  await store.update((state) => state.agentRuns.push({
    id: "agent", ideaId: "idea", branch: "burner/receipt", worktree: f.worktree, status: "revising", startedAt: new Date().toISOString(),
    resources: [], deltas: [], reviewRounds: [], continuation: {
      id: "completed-author", identity: { baseRef: "main", baseCommit: f.base, branch: "burner/receipt", evaluationFingerprint: "test", remote: "origin", baseBranch: "main" },
      head: f.base, step: "commit", tree: prepared.tree, source: { kind: "author", reason: { kind: "initial" } },
      result: { threadId: "existing-author", message: "Completed implementation" }, commitMessage: "implementation",
    },
  }));
  const committed = await f.git.finalizeLeafCommit(f.worktree, "burner/receipt", prepared, "implementation");
  const recovered = new StateStore(f.root);
  await recovered.init();
  const receipt = recovered.get().agentRuns[0].continuation;
  assert.equal(receipt.step, "commit");
  assert.equal(receipt.result.message, "Completed implementation");
  assert.equal(await f.git.finalizeLeafCommit(f.worktree, "burner/receipt", { inputHead: receipt.head, tree: receipt.tree }, receipt.commitMessage), committed);
  assert.equal(await gitCommand(f.worktree, "rev-list", "--count", "HEAD"), "2", "receipt replay creates zero additional commits");
  assert.equal(await gitCommand(f.worktree, "rev-list", "--parents", "-n", "1", "HEAD"), `${committed} ${f.base}`);
  assert.equal(await f.git.tree(committed), prepared.tree);
  assert.equal(await f.git.hasChanges(f.worktree), false);
  assert.equal(await readFile(join(f.worktree, "target", "historical.json"), "utf8"), '{"measured":true}\n');
  f.pass();
});

test("real Git no-op finalization does not manufacture an empty commit", async (t) => {
  const f = await repository(t);
  const receipt = await f.git.prepareLeafCommit(f.worktree, "burner/receipt", f.base);
  assert.equal(receipt.tree, await f.git.tree(f.base));
  assert.equal(await f.git.finalizeLeafCommit(f.worktree, "burner/receipt", receipt, "no-op"), f.base);
  assert.equal(await f.git.finalizeLeafCommit(f.worktree, "burner/receipt", receipt, "retry no-op"), f.base);
  assert.equal(await gitCommand(f.worktree, "rev-list", "--count", "HEAD"), "1");
  f.pass();
});

test("real Git receipt mismatches leave staged, unstaged, untracked and wrong-head files intact", async (t) => {
  for (const mismatch of ["staged", "unstaged", "untracked", "wrong-parent", "wrong-tree", "wrong-branch", "dirty-after-commit"]) await t.test(mismatch, async (t) => {
    const f = await repository(t);
    await writeFile(join(f.worktree, "code.txt"), "intended implementation\n");
    const receipt = await f.git.prepareLeafCommit(f.worktree, "burner/receipt", f.base);
    if (mismatch === "staged" || mismatch === "unstaged") {
      await writeFile(join(f.worktree, "code.txt"), `${mismatch} external edit\n`);
      if (mismatch === "staged") await gitCommand(f.worktree, "add", "code.txt");
    } else if (mismatch === "untracked") await writeFile(join(f.worktree, "external.txt"), "keep untracked\n");
    else if (mismatch === "wrong-parent") {
      await f.git.finalizeLeafCommit(f.worktree, "burner/receipt", receipt, "intended");
      await gitCommand(f.worktree, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "foreign empty commit");
    } else if (mismatch === "wrong-tree") {
      await writeFile(join(f.worktree, "code.txt"), "foreign commit\n");
      await f.git.commit(f.worktree, "foreign");
    } else if (mismatch === "wrong-branch") await gitCommand(f.worktree, "switch", "-c", "burner/foreign");
    else {
      await f.git.finalizeLeafCommit(f.worktree, "burner/receipt", receipt, "intended");
      await writeFile(join(f.worktree, "external.txt"), "keep after commit\n");
    }
    const head = await f.git.head(f.worktree);
    const index = await gitCommand(f.worktree, "write-tree");
    const content = await readFile(join(f.worktree, "code.txt"), "utf8");
    await assert.rejects(f.git.finalizeLeafCommit(f.worktree, "burner/receipt", receipt, "must not commit"), /left untouched/);
    assert.equal(await f.git.head(f.worktree), head);
    assert.equal(await gitCommand(f.worktree, "write-tree"), index);
    assert.equal(await readFile(join(f.worktree, "code.txt"), "utf8"), content);
    if (["untracked", "dirty-after-commit"].includes(mismatch)) assert.match(await readFile(join(f.worktree, "external.txt"), "utf8"), /keep/);
    f.pass();
  });
});

test("actual queue retry CLI uses manual initialization and only delivers its target with autoRun configured", async (t) => {
  const f = await repository(t);
  const bare = join(f.root, ".burner", "remote.git");
  await gitCommand(f.root, "init", "--bare", bare);
  await gitCommand(f.root, "remote", "add", "origin", bare);
  await writeFile(join(f.worktree, "code.txt"), "approved candidate\n");
  const head = await f.git.commit(f.worktree, "candidate");
  await f.git.push(f.worktree, "origin", "burner/receipt");
  const tree = await f.git.tree(head);
  const store = new StateStore(f.root);
  await store.init();
  const timestamp = new Date().toISOString();
  const leafRepository = { host: "example.test", id: "cli-fixture-repository", nameWithOwner: "fixture/leaf-cli" };
  const url = `https://${leafRepository.host}/${leafRepository.nameWithOwner}/pull/42`;
  await store.update((state) => {
    Object.assign(state.settings, { autoRun: true, maxReviewRounds: 1, autoCreatePrs: true });
    state.evaluations = [{ id: "perf", name: "Performance", command: "must-not-execute", prompt: "Frozen evaluation", weight: 1, enabled: true, createdAt: timestamp, definitionVersion: "v1" }];
    const fingerprint = fullMergeValidationFingerprint(state);
    const deltas = [{ evaluationId: "perf", name: "Performance", before: 70, after: 68, delta: -2 }];
    state.ideas = [
      { id: "idea", title: "Target", description: "Deliver only this candidate", rationale: "Recover", predictedImpact: 1, evaluationIds: ["perf"], resources: [], status: "failed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "agent" },
      { id: "unrelated", title: "Must remain queued", description: "Do not dispatch", rationale: "Scope", predictedImpact: 100, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "manual" },
    ];
    state.agentRuns = [{
      id: "agent", ideaId: "idea", branch: "burner/receipt", worktree: f.worktree, status: "failed", startedAt: timestamp, completedAt: timestamp,
      resources: [], baseRef: "main", baseCommit: f.base, authorThreadId: "original-author", deltas, impact: -2, reviewApproved: true,
      reviewRounds: [{ id: "review", round: 1, commit: head, approved: true, summary: "Approved", findings: [], createdAt: timestamp, completedAt: timestamp, baseCommit: f.base, evaluationFingerprint: fingerprint }],
      prNumber: 42, prUrl: url, prState: "open",
      fullMergeValidation: { baseCommit: f.base, candidateCommit: head, candidateTree: tree, evaluationFingerprint: fingerprint, qualified: false, deltas, impact: -2, completedAt: timestamp },
      continuation: { id: "delivery", head, identity: { baseRef: "main", baseCommit: f.base, branch: "burner/receipt", evaluationFingerprint: fingerprint, remote: "origin", baseBranch: "main", pullRequest: { number: 42, head, url } }, step: "delivery", approvalRoundId: "review" },
    }];
    state.agentRuns[0].leafPr = fixtureLeafPr(state.agentRuns[0], { title: "Target", body: "", isDraft: true, state: "OPEN" }, { repository: leafRepository });
  });
  const bin = join(f.root, ".burner", "bin");
  await mkdir(bin);
  const log = join(f.root, ".burner", "effects.jsonl");
  const gh = join(bin, "gh");
  const remoteState = join(f.root, ".burner", "pr-observation.json");
  const rawRepository = { id: leafRepository.id, nameWithOwner: leafRepository.nameWithOwner, url: `https://${leafRepository.host}/${leafRepository.nameWithOwner}` };
  await writeFile(remoteState, JSON.stringify({ number: 42, state: "OPEN", headRefName: "burner/receipt", headRefOid: head,
    url, title: "Target", body: "", isDraft: true, baseRefName: "main", baseRefOid: f.base, mergeable: "MERGEABLE", mergeCommit: null,
    headRepository: rawRepository, baseRepository: rawRepository, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] } }));
  await writeFile(log, "");
  // The real CLI consumes typed GraphQL ingress and its existing durable owner.
  // Only transport metadata is fake; every Git effect still targets the local
  // configured file remote, never the apparent GitHub coordinates below.
  await writeFile(gh, `#!${process.execPath}
const assert = require('node:assert/strict'), fs = require('node:fs');
const args = process.argv.slice(2), log = ${JSON.stringify(log)}, path = ${JSON.stringify(remoteState)};
const repo = ${JSON.stringify(rawRepository)}, observed = JSON.parse(fs.readFileSync(path, 'utf8'));
const record = (value) => fs.appendFileSync(log, JSON.stringify(value) + '\\n');
if (JSON.stringify(args) === '["--version"]' || JSON.stringify(args) === '["auth","status"]') {
  record({kind:'readiness',args}); process.exit(0);
}
if (args[0] === 'api') {
  assert.deepEqual(args, ['api','graphql','--hostname','example.test','--method','POST','--input','-']);
  const request = JSON.parse(fs.readFileSync(0,'utf8')); record({kind:'graphql',operation:request.operationName});
  if (request.operationName === 'LeafRepository') {
    assert.deepEqual(request.variables,{owner:'fixture',name:'leaf-cli'}); console.log(JSON.stringify({data:{repository:repo}}));
  } else {
    assert.equal(request.operationName,'LeafPullRequest'); assert.deepEqual(request.variables,{repository:repo.id,number:42});
    console.log(JSON.stringify({data:{node:{...repo,pullRequest:observed}}}));
  }
} else {
  assert.equal(args[0],'pr'); assert.equal(args[2],'42'); assert.equal(args.at(-2),'--repo'); assert.equal(args.at(-1),'example.test/fixture/leaf-cli');
  const run = JSON.parse(fs.readFileSync(${JSON.stringify(store.statePath)},'utf8')).agentRuns[0];
  const effect = run.leafPr.pending.effect; assert.deepEqual(effect.before,{title:observed.title,body:observed.body,isDraft:observed.isDraft,state:observed.state});
  assert.equal(args[1],'edit'); assert.equal(args.length,7); assert.equal(effect.kind,'edit');
  assert.ok(args[3] === '--title' || args[3] === '--body'); assert.equal(effect.field,args[3].slice(2));
  observed[effect.field]=args[4];
  assert.deepEqual(effect.after,{title:observed.title,body:observed.body,isDraft:observed.isDraft,state:observed.state});
  fs.writeFileSync(path,JSON.stringify(observed)); record({kind:'mutation',args});
}
`);
  const codex = join(bin, "codex");
  await writeFile(codex, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)},'"UNEXPECTED MODEL"\\n');process.exit(92);\n`);
  await chmod(gh, 0o755); await chmod(codex, 0o755);
  const actualGit = realpathSync(process.env.PATH.split(delimiter).map((directory) => join(directory, "git")).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  }));
  const gitIngress = join(bin, "git-identity");
  await writeFile(gitIngress, `#!${process.execPath}
const assert=require('node:assert/strict'),args=process.argv.slice(2);
assert.ok(JSON.stringify(args)==='["remote","get-url","--all","origin"]'||JSON.stringify(args)==='["remote","get-url","--push","--all","origin"]');
console.log('https://example.test/fixture/leaf-cli.git');
`);
  await chmod(gitIngress, 0o700);
  for (const path of [codex, gh, gitIngress]) { assert.equal(lstatSync(path).isFile(), true); assert.equal(realpathSync(path), path); accessSync(path, constants.X_OK); }
  const guard = join(bin, "cli-subprocess-guard.mjs");
  await writeFile(guard, `import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {appendFileSync,accessSync,constants,lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const sandbox=${JSON.stringify(f.sandbox)}, log=${JSON.stringify(log)}, spawn=cp.spawn;
const executable=(path)=>{assert.equal(lstatSync(path).isFile(),true);assert.equal(realpathSync(path),path);accessSync(path,constants.X_OK);return path;};
executable(${JSON.stringify(codex)});
cp.spawn=(command,args,options)=>{
  try {
    const cwd=resolve(options.cwd);assert.ok(cwd===sandbox||cwd.startsWith(sandbox+sep));
    let present=cwd;while(true){try{lstatSync(present);break;}catch(error){if(error.code!=='ENOENT'||present===sandbox)throw error;present=dirname(present);}}
    assert.equal(realpathSync(present),present);
    const env={PATH:${JSON.stringify(`${dirname(actualGit)}:/usr/bin:/bin`)},LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0'};
    if(options.env?.GIT_INDEX_FILE){const index=resolve(options.env.GIT_INDEX_FILE);assert.ok(index.startsWith(sandbox+sep));assert.equal(realpathSync(dirname(index)),dirname(index));env.GIT_INDEX_FILE=index;}
    if(options.env?.GIT_NO_REPLACE_OBJECTS!==undefined){assert.equal(options.env.GIT_NO_REPLACE_OBJECTS,'1');env.GIT_NO_REPLACE_OBJECTS='1';}
    if(options.env?.GIT_GRAFT_FILE!==undefined){assert.equal(options.env.GIT_GRAFT_FILE,'/dev/null');env.GIT_GRAFT_FILE='/dev/null';}
    if(command==='git'){
      const identity=JSON.stringify(args)==='["remote","get-url","--all","origin"]'||JSON.stringify(args)==='["remote","get-url","--push","--all","origin"]';
      return spawn(identity?executable(${JSON.stringify(gitIngress)}):${JSON.stringify(actualGit)},args,{...options,env});
    }
    assert.equal(command,'gh','No model, command evaluator, shell, or other executable fallthrough');
    return spawn(executable(${JSON.stringify(gh)}),args,{...options,env});
  } catch(error){appendFileSync(log,JSON.stringify({kind:'blocked',command,args,message:error.message})+'\\n');throw error;}
};
syncBuiltinESMExports();
`);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = await runCommand(process.execPath, ["--import", guard, cli, "queue", "retry", "--run", "agent", "--retain-worktree", "-C", f.root], {
    cwd: f.root, env: { PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: "", TMPDIR: join(f.sandbox, "tmp") }, timeoutMs: 30_000,
  });
  await writeFile(join(f.root, ".burner", "cli-result.json"), JSON.stringify(result, null, 2));
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const delivered = JSON.parse(result.stdout);
  assert.equal(delivered.continuation.step, "done");
  assert.equal(delivered.prNumber, 42);
  assert.equal(delivered.impact, -2);
  assert.equal(delivered.reviewRounds.length, 1);
  assert.equal(delivered.retainWorktree, true, "the actual CLI must transport the one-way retention opt-in");
  assert.deepEqual(delivered.leafPr.repository, leafRepository);
  assert.equal(await f.git.head(f.worktree), head);
  const persisted = JSON.parse(await readFile(store.statePath, "utf8"));
  assert.equal(persisted.settings.autoRun, true);
  assert.equal(persisted.orchestrator.enabled, false);
  assert.equal(persisted.ideas.find((idea) => idea.id === "unrelated").status, "queued");
  assert.equal(persisted.agentRuns.length, 1);
  assert.equal(persisted.evaluationRuns.length, 0);
  const effects = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(effects.some((effect) => effect.kind === "mutation"), "the target really reached exact owned publication");
  assert.ok(effects.every((effect) => ["graphql", "mutation", "readiness"].includes(effect.kind)), "all model/evaluator/generic remote fallthrough remained forbidden");
  assert.equal(persisted.agentRuns[0].retainWorktree, true);

  await store.refresh();
  await store.update((state) => state.composites.push({ id: "queued", title: "Queued", description: "Unrelated", status: "queued", branch: "burner/queued", worktree: "", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false }));
  const refused = await runCommand(process.execPath, ["--import", guard, cli, "queue", "retry", "--run", "agent", "-C", f.root], { cwd: f.root, env: { PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: "", TMPDIR: join(f.sandbox, "tmp") }, timeoutMs: 30_000 });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /Burner server is active/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, effects.length, "queued-composite preflight remains a refusal before initialization");
  f.pass();
});
