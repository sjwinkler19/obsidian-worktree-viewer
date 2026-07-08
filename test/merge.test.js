'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { git, runPreflight, mergeAndPrune, parseWorktrees } = require('../main.js');

async function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@test']);
  await git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'note.md'), 'hello\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

async function addWorktree(repo, name) {
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), `wt-${name}-`));
  fs.rmSync(wtPath, { recursive: true, force: true }); // worktree add wants a non-existent dir
  await git(repo, ['worktree', 'add', '-b', name, wtPath]);
  await git(wtPath, ['config', 'user.email', 'test@test']);
  await git(wtPath, ['config', 'user.name', 'test']);
  return { path: wtPath, branch: name };
}

test('happy path: committed worktree (filename with spaces) merges, prunes, deletes branch', async (t) => {
  const repo = await makeRepo(t);
  const wt = await addWorktree(repo, 'agent-a');
  // Regression: git C-quotes paths with spaces in newline porcelain output;
  // -z mode must carry them verbatim end to end.
  fs.writeFileSync(path.join(wt.path, 'Role Decomposition - FDE.md'), 'work\n');
  await git(wt.path, ['add', '.']);
  await git(wt.path, ['commit', '-m', 'agent work']);

  const decision = await runPreflight(repo, 'main', wt);
  assert.strictEqual(decision.ok, true);

  await mergeAndPrune(repo, 'main', wt);
  assert.ok(fs.existsSync(path.join(repo, 'Role Decomposition - FDE.md')), 'merged spaced-name file present in main');
  assert.ok(!fs.existsSync(wt.path), 'worktree directory removed');
  assert.strictEqual((await git(repo, ['branch', '--list', 'agent-a'])).trim(), '', 'branch deleted');
  assert.strictEqual(parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain'])).length, 1);
});

test('spaces regression: untracked + status parsing return verbatim paths', async (t) => {
  const repo = await makeRepo(t);
  const wt = await addWorktree(repo, 'agent-space');
  fs.writeFileSync(path.join(wt.path, 'has space.md'), 'wip\n');
  const { parseUntracked } = require('../main.js');
  const status = await git(wt.path, ['status', '--porcelain', '-z']);
  const untracked = parseUntracked(status);
  assert.deepStrictEqual(untracked, [{ status: '?', path: 'has space.md' }]);
  // The verbatim path must resolve on disk — this is exactly what the preview does.
  assert.ok(fs.existsSync(path.join(wt.path, untracked[0].path)));
});

test('dirty worktree: preflight offers commit-then-merge, which succeeds', async (t) => {
  const repo = await makeRepo(t);
  const wt = await addWorktree(repo, 'agent-b');
  fs.writeFileSync(path.join(wt.path, 'uncommitted.md'), 'wip\n');

  const decision = await runPreflight(repo, 'main', wt);
  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.canCommitThenMerge, true);

  await mergeAndPrune(repo, 'main', wt, { commitFirst: true });
  assert.ok(fs.existsSync(path.join(repo, 'uncommitted.md')), 'auto-committed file merged into main');
  assert.ok(!fs.existsSync(wt.path));
});

test('overlap: main has local edits to a file the branch changed — refused', async (t) => {
  const repo = await makeRepo(t);
  const wt = await addWorktree(repo, 'agent-c');
  fs.writeFileSync(path.join(wt.path, 'note.md'), 'agent version\n');
  await git(wt.path, ['add', '.']);
  await git(wt.path, ['commit', '-m', 'agent edits note']);
  fs.writeFileSync(path.join(repo, 'note.md'), 'my uncommitted edit\n'); // user mid-edit in main

  const decision = await runPreflight(repo, 'main', wt);
  assert.strictEqual(decision.ok, false);
  assert.match(decision.reason, /note\.md/);
  await assert.rejects(() => mergeAndPrune(repo, 'main', wt), /aborted/);
  assert.ok(fs.existsSync(wt.path), 'nothing was deleted on refusal');
});

test('non-ff: main moved since branching — refused without commit-then-merge escape', async (t) => {
  const repo = await makeRepo(t);
  const wt = await addWorktree(repo, 'agent-d');
  fs.writeFileSync(path.join(wt.path, 'agent.md'), 'work\n');
  await git(wt.path, ['add', '.']);
  await git(wt.path, ['commit', '-m', 'agent work']);
  fs.writeFileSync(path.join(repo, 'other.md'), 'main moved\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'main advances']);

  const decision = await runPreflight(repo, 'main', wt);
  assert.strictEqual(decision.ok, false);
  assert.match(decision.reason, /fast-forward/);
  assert.strictEqual(decision.canCommitThenMerge, undefined);
});

test('TOCTOU: state changes after preflight — mergeAndPrune re-checks and aborts', async (t) => {
  const repo = await makeRepo(t);
  const wt = await addWorktree(repo, 'agent-e');
  fs.writeFileSync(path.join(wt.path, 'agent.md'), 'work\n');
  await git(wt.path, ['add', '.']);
  await git(wt.path, ['commit', '-m', 'agent work']);

  const decision = await runPreflight(repo, 'main', wt);
  assert.strictEqual(decision.ok, true, 'preflight passes before the world changes');

  // The "modal sits open" window: main advances, making the merge non-ff.
  fs.writeFileSync(path.join(repo, 'other.md'), 'race\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'race commit']);

  await assert.rejects(() => mergeAndPrune(repo, 'main', wt), /aborted/);
  assert.ok(fs.existsSync(wt.path), 'worktree untouched after aborted merge');
});
