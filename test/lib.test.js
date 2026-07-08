'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../main.js');

test('parseWorktrees: main, flagged, detached, empty', () => {
  const sample = [
    'worktree /repo/main',
    'HEAD 1234567890abcdef1234567890abcdef12345678',
    'branch refs/heads/main',
    '',
    'worktree /repo/feature-x',
    'HEAD abcdef1234567890abcdef1234567890abcdef12',
    'branch refs/heads/feature/x',
    'locked',
    '',
    'worktree /repo/detached-wt',
    'HEAD 9999999999999999999999999999999999999999',
    'detached',
    '',
  ].join('\n');
  const wts = lib.parseWorktrees(sample);
  assert.strictEqual(wts.length, 3);
  assert.strictEqual(wts[0].branch, 'main');
  assert.strictEqual(wts[1].branch, 'feature/x');
  assert.strictEqual(wts[1].locked, true);
  assert.strictEqual(wts[2].branch, undefined);
  assert.deepStrictEqual(lib.parseWorktrees(''), []);
});

test('parseNameStatus (-z): statuses, renames, paths with spaces stay verbatim', () => {
  const changes = lib.parseNameStatus('M\0a/b with space.md\0A\0new.md\0R100\0old.md\0renamed file.md\0');
  assert.deepStrictEqual(changes, [
    { status: 'M', path: 'a/b with space.md' },
    { status: 'A', path: 'new.md' },
    { status: 'R', path: 'renamed file.md' },
  ]);
  assert.deepStrictEqual(lib.parseNameStatus(''), []);
});

test('parseStatusZ + parseUntracked + unionChanges (-z): spaces verbatim, diff status wins', () => {
  const raw = ' M tracked file.md\0?? scratch has space.md\0?? also.md\0';
  assert.deepStrictEqual(lib.parseStatusZ(raw), [
    { xy: ' M', path: 'tracked file.md' },
    { xy: '??', path: 'scratch has space.md' },
    { xy: '??', path: 'also.md' },
  ]);
  const untracked = lib.parseUntracked(raw);
  assert.deepStrictEqual(untracked, [
    { status: '?', path: 'scratch has space.md' },
    { status: '?', path: 'also.md' },
  ]);
  const union = lib.unionChanges([{ status: 'A', path: 'also.md' }], untracked);
  assert.deepStrictEqual(union, [
    { status: 'A', path: 'also.md' },
    { status: '?', path: 'scratch has space.md' },
  ]);
});

test('parseStatusZ: rename entries skip the trailing orig-path token', () => {
  const entries = lib.parseStatusZ('R  new name.md\0old name.md\0?? other.md\0');
  assert.deepStrictEqual(entries, [
    { xy: 'R ', path: 'new name.md' },
    { xy: '??', path: 'other.md' },
  ]);
});

test('filterMainStatus (-z): drops untracked .obsidian churn, keeps real edits', () => {
  const status = ' M Telos/my note.md\0?? Telos/.obsidian/workspace.json\0?? Telos/new note.md\0';
  const filtered = lib.filterMainStatus(status);
  assert.ok(filtered.includes('Telos/my note.md'));
  assert.ok(filtered.includes('Telos/new note.md'));
  assert.ok(!filtered.includes('.obsidian'));
});

test('rowSlice: stable for same inputs, moves on status/base changes, main filters churn', () => {
  const wt = { head: 'abc', branch: 'x' };
  const a = lib.rowSlice(wt, ' M f.md\n', 'base1', false);
  assert.strictEqual(a, lib.rowSlice(wt, ' M f.md\n', 'base1', false));
  assert.notStrictEqual(a, lib.rowSlice(wt, ' M g.md\n', 'base1', false));
  assert.notStrictEqual(a, lib.rowSlice(wt, ' M f.md\n', 'base2', false));
  // main: .obsidian-only churn does not move the slice
  const m1 = lib.rowSlice(wt, '?? v/.obsidian/workspace.json\n', '', true);
  const m2 = lib.rowSlice(wt, '', '', true);
  assert.strictEqual(m1, m2);
});

test('preflightDecision: overlap refuses, non-ff refuses, dirty offers commit-then-merge', () => {
  const overlap = lib.preflightDecision({
    wtStatus: '', mainStatus: ' M shared note.md\0', changedPaths: ['shared note.md', 'other.md'], ffPossible: true,
  });
  assert.strictEqual(overlap.ok, false);
  assert.match(overlap.reason, /shared note\.md/);

  const nonff = lib.preflightDecision({ wtStatus: '', mainStatus: '', changedPaths: ['a.md'], ffPossible: false });
  assert.strictEqual(nonff.ok, false);
  assert.strictEqual(nonff.canCommitThenMerge, undefined);

  const dirty = lib.preflightDecision({ wtStatus: ' M wip.md\0', mainStatus: '', changedPaths: ['wip.md'], ffPossible: true });
  assert.strictEqual(dirty.ok, false);
  assert.strictEqual(dirty.canCommitThenMerge, true);

  const clean = lib.preflightDecision({ wtStatus: '', mainStatus: '?? unrelated.md\0', changedPaths: ['a.md'], ffPossible: true });
  assert.strictEqual(clean.ok, true);
});

test('buildCwdIndex + newestJsonlMtime: reads cwd from first lines, missing dir is null', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projDir = path.join(root, '-Users-synthetic-My-Repo');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'sess.jsonl'), JSON.stringify({ cwd: '/synthetic/My Repo' }) + '\n{"more":"lines"}\n');
  const junkDir = path.join(root, 'junk');
  fs.mkdirSync(junkDir);
  fs.writeFileSync(path.join(junkDir, 'bad.jsonl'), 'not json\n');

  const index = lib.buildCwdIndex(root);
  assert.strictEqual(index.get('/synthetic/My Repo'), projDir);
  assert.strictEqual(index.size, 1);

  assert.ok(lib.newestJsonlMtime(projDir) > 0);
  assert.strictEqual(lib.newestJsonlMtime(path.join(root, 'nope')), null);
  assert.deepStrictEqual(lib.buildCwdIndex(path.join(root, 'missing')), new Map());
});

test('relativeTime: seconds, minutes, hours, days', () => {
  assert.strictEqual(lib.relativeTime(12 * 1000), '12s');
  assert.strictEqual(lib.relativeTime(4 * 60 * 1000), '4m');
  assert.strictEqual(lib.relativeTime(3 * 3600 * 1000), '3h');
  assert.strictEqual(lib.relativeTime(72 * 3600 * 1000), '3d');
});
