'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { git, parseGithubRemote, compareUrl, pushAndCreatePr } = require('../main.js');

test('parseGithubRemote: https, ssh, non-github', () => {
  assert.deepStrictEqual(parseGithubRemote('https://github.com/philippwinkler/telos.git'), { owner: 'philippwinkler', repo: 'telos' });
  assert.deepStrictEqual(parseGithubRemote('git@github.com:me/my-repo.git'), { owner: 'me', repo: 'my-repo' });
  assert.deepStrictEqual(parseGithubRemote('https://github.com/me/no-suffix'), { owner: 'me', repo: 'no-suffix' });
  assert.strictEqual(parseGithubRemote('/tmp/some/bare.git'), null);
});

test('compareUrl: builds the PR-create page URL, null for non-github', () => {
  assert.strictEqual(
    compareUrl('git@github.com:me/telos.git', 'main', 'claude/agent-a'),
    'https://github.com/me/telos/compare/main...claude%2Fagent-a?expand=1'
  );
  assert.strictEqual(compareUrl('/tmp/bare.git', 'main', 'x'), null);
});

async function makeRepoWithOrigin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pr-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pr-origin-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bare, { recursive: true, force: true }); });
  await git(bare, ['init', '--bare', '-b', 'main']);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t']);
  await git(dir, ['config', 'user.name', 't']);
  await git(dir, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(dir, 'note.md'), 'hello\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['push', '-u', 'origin', 'main']);
  return { dir, bare };
}

async function addWorktree(repo, name) {
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), `wt-${name}-`));
  fs.rmSync(wtPath, { recursive: true, force: true });
  await git(repo, ['worktree', 'add', '-b', name, wtPath]);
  await git(wtPath, ['config', 'user.email', 't@t']);
  await git(wtPath, ['config', 'user.name', 't']);
  return { path: wtPath, branch: name };
}

test('pushAndCreatePr: commits dirty work, pushes branch, returns gh PR URL', async (t) => {
  const { dir, bare } = await makeRepoWithOrigin(t);
  const wt = await addWorktree(dir, 'agent-pr');
  fs.writeFileSync(path.join(wt.path, 'agent note.md'), 'wip\n'); // uncommitted, spaced name

  const fakeGh = async () => ({ stdout: 'https://github.com/me/telos/pull/7\n' });
  const result = await pushAndCreatePr('main', wt, { commitFirst: true, exec: fakeGh });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.url, 'https://github.com/me/telos/pull/7');
  const remoteBranches = await git(bare, ['branch', '--list', 'agent-pr']);
  assert.match(remoteBranches, /agent-pr/, 'branch exists on origin after push');
  const wtStatus = await git(wt.path, ['status', '--porcelain', '-z']);
  assert.strictEqual(wtStatus.trim(), '', 'worktree fully committed');
  assert.ok(fs.existsSync(wt.path), 'worktree NOT pruned — stays until PR merges');
});

test('pushAndCreatePr: gh failure falls back to GitHub compare URL', async (t) => {
  const { dir } = await makeRepoWithOrigin(t);
  const wt = await addWorktree(dir, 'agent-fallback');
  fs.writeFileSync(path.join(wt.path, 'x.md'), 'work\n');
  await git(wt.path, ['add', '.']);
  await git(wt.path, ['commit', '-m', 'work']);

  const failingGh = async () => { throw new Error('gh not found'); };
  // remote get-url must report a github URL for the fallback; delegate the rest to real git
  const gitStub = (cwd, args) => (args[0] === 'remote' && args[1] === 'get-url')
    ? Promise.resolve('git@github.com:me/telos.git\n')
    : git(cwd, args);

  const result = await pushAndCreatePr('main', wt, { commitFirst: false, exec: failingGh }, gitStub);
  assert.strictEqual(result.created, false);
  assert.strictEqual(result.url, 'https://github.com/me/telos/compare/main...agent-fallback?expand=1');
});

test('pushAndCreatePr: refuses when there is nothing to PR', async (t) => {
  const { dir } = await makeRepoWithOrigin(t);
  const wt = await addWorktree(dir, 'agent-empty');
  await assert.rejects(
    () => pushAndCreatePr('main', wt, { commitFirst: false, exec: async () => ({ stdout: '' }) }),
    /nothing to PR/
  );
});
