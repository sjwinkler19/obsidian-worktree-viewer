'use strict';

/*
 * Worktree Mission Control — v0.2
 *
 *   WorktreeStore (extends obsidian.Events)
 *     poll every 4s while subscribers > 0 (refcounted)              [6A, D8.9]
 *       worktree list --porcelain ─┬─ per wt: status --porcelain    [D8.5 no-optional-locks]
 *                                  ├─ merge-base vs main (cached)   [D8.6]
 *                                  ├─ diff --name-status <base> ∪ untracked
 *                                  └─ per-row slice (main: minus .obsidian churn) [D8.2]
 *       emit 'change' (set of rows whose slice moved) + 'presence' every tick    [D8.8]
 *   Merge: preflight (overlap + ff + advisory presence) → modal
 *          → re-preflight → ff merge → worktree remove → branch -d  [D8.1, D8.7, 3A]
 *
 * Under plain node (node --test) this module exports the pure API below;
 * inside Obsidian it exports the Plugin class.                      [D8.3]
 */

let obsidian = null;
try { obsidian = require('obsidian'); } catch (_) { /* running under node, not Obsidian */ }

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const execFileP = promisify(execFile);

// ---------------- pure core (tested via `node --test`) ----------------

async function git(cwd, args) {
  try {
    // ponytail: --no-optional-locks on everything — polled commands must never
    // take the index lock agents need [D8.5]; harmless on the merge path.
    const { stdout } = await execFileP('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new Error((err.stderr || '').trim() || err.message);
  }
}

// Parses `git worktree list --porcelain` output into worktree objects.
function parseWorktrees(output) {
  return output
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const wt = {};
      for (const line of block.split('\n')) {
        const [key, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (key === 'worktree') wt.path = value;
        else if (key === 'HEAD') wt.head = value;
        else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
        else if (key === 'bare') wt.bare = true;
        else if (key === 'locked') wt.locked = true;
        else if (key === 'prunable') wt.prunable = true;
      }
      return wt;
    })
    .filter((wt) => wt.path);
}

// All parsed git output uses -z (NUL-separated): git C-quotes paths with
// spaces/non-ASCII in newline mode, which corrupts every downstream path use.

// Parses `git diff --name-status -z` output; renames report the new path.
function parseNameStatus(output) {
  const tokens = output.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      changes.push({ status, path: tokens[i + 2] }); // src, then dst
      i += 2;
    } else {
      changes.push({ status, path: tokens[i + 1] });
      i += 1;
    }
  }
  return changes.filter((c) => c.path);
}

// Parses `git status --porcelain -z` into {xy, path} entries.
function parseStatusZ(statusOut) {
  const tokens = statusOut.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const xy = t.slice(0, 2);
    entries.push({ xy, path: t.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // skip the following orig-path token
  }
  return entries;
}

// Untracked entries from `git status --porcelain -z`, rendered as status '?'.
function parseUntracked(statusOut) {
  return parseStatusZ(statusOut)
    .filter((e) => e.xy === '??')
    .map((e) => ({ status: '?', path: e.path }));
}

// Union of diff changes and untracked entries; diff status wins on collision.
function unionChanges(diffChanges, untracked) {
  const seen = new Set(diffChanges.map((c) => c.path));
  return diffChanges.concat(untracked.filter((u) => !seen.has(u.path)));
}

// Fingerprint noise filter for the main worktree: untracked .obsidian config
// churn (workspace.json etc.) must not trigger re-renders [D8.2].
function filterMainStatus(statusOut) {
  return parseStatusZ(statusOut)
    .filter((e) => !(e.xy === '??' && e.path.includes('.obsidian/')))
    .map((e) => `${e.xy} ${e.path}`)
    .join('\n');
}

// Per-row fingerprint slice: a row re-renders only when this changes [D8.2, D8.6].
function rowSlice(wt, statusOut, baseSha, isMain) {
  return [wt.head, wt.branch || '', isMain ? filterMainStatus(statusOut) : statusOut, baseSha].join(' ');
}

// Pure merge-preflight decision [D8.1, D8.7]. Inputs are raw git outputs.
function preflightDecision({ wtStatus, mainStatus, changedPaths, ffPossible }) {
  const mainPaths = new Set(parseStatusZ(mainStatus).map((e) => e.path));
  const overlap = changedPaths.filter((p) => mainPaths.has(p));
  if (overlap.length) {
    return { ok: false, reason: `merge touches files modified in main: ${overlap.join(', ')}` };
  }
  if (!ffPossible) {
    return { ok: false, reason: 'not fast-forwardable: main has moved since this worktree branched' };
  }
  if (wtStatus.trim()) {
    return { ok: false, canCommitThenMerge: true, reason: 'worktree has uncommitted changes' };
  }
  return { ok: true };
}

async function runPreflight(mainPath, mainBranch, wt, gitFn = git) {
  const [wtStatus, mainStatus, changed, mergeBase, mainHead] = await Promise.all([
    gitFn(wt.path, ['status', '--porcelain', '-z']),
    gitFn(mainPath, ['status', '--porcelain', '-z']),
    gitFn(mainPath, ['diff', '--name-only', '-z', `${mainBranch}..${wt.branch}`]),
    gitFn(mainPath, ['merge-base', mainBranch, wt.branch]),
    gitFn(mainPath, ['rev-parse', mainBranch]),
  ]);
  return preflightDecision({
    wtStatus,
    mainStatus,
    changedPaths: changed.split('\0').filter(Boolean),
    ffPossible: mergeBase.trim() === mainHead.trim(),
  });
}

// The one destructive sequence. Re-runs the preflight immediately before
// executing — the confirm modal sits open at human speed [3A].
async function mergeAndPrune(mainPath, mainBranch, wt, { commitFirst = false } = {}, gitFn = git) {
  if (commitFirst) {
    await gitFn(wt.path, ['add', '-A']);
    await gitFn(wt.path, ['commit', '-m', `worktree: accept ${wt.branch}`]);
  }
  const check = await runPreflight(mainPath, mainBranch, wt, gitFn);
  if (!check.ok) throw new Error(`aborted: ${check.reason}`);
  await gitFn(mainPath, ['merge', '--ff-only', wt.branch]);
  await gitFn(mainPath, ['worktree', 'remove', wt.path]);
  await gitFn(mainPath, ['branch', '-d', wt.branch]);
}

// Maps real cwd → Claude project dir by reading the cwd field from transcript
// first lines — no slug-rule guessing, the rule has already drifted [D8.4].
function buildCwdIndex(projectsDir, fsi = fs) {
  const index = new Map();
  let dirs = [];
  try { dirs = fsi.readdirSync(projectsDir); } catch (_) { return index; }
  for (const d of dirs) {
    const dir = path.join(projectsDir, d);
    let files = [];
    try { files = fsi.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      try {
        const fd = fsi.openSync(path.join(dir, f), 'r');
        const buf = Buffer.alloc(8192);
        const n = fsi.readSync(fd, buf, 0, 8192, 0);
        fsi.closeSync(fd);
        const text = buf.slice(0, n).toString('utf8');
        const nl = text.indexOf('\n');
        const cwd = JSON.parse(nl === -1 ? text : text.slice(0, nl)).cwd;
        if (cwd) { index.set(cwd, dir); break; }
      } catch (_) { /* malformed or >8k first line — try the next file */ }
    }
  }
  return index;
}

function newestJsonlMtime(dir, fsi = fs) {
  try {
    let newest = 0;
    for (const f of fsi.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = fsi.statSync(path.join(dir, f)).mtimeMs;
      if (m > newest) newest = m;
    }
    return newest || null;
  } catch (_) {
    return null;
  }
}

function relativeTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

if (!obsidian) {
  module.exports = {
    git, parseWorktrees, parseNameStatus, parseStatusZ, parseUntracked, unionChanges,
    filterMainStatus, rowSlice, preflightDecision, runPreflight, mergeAndPrune,
    buildCwdIndex, newestJsonlMtime, relativeTime,
  };
  return;
}

// ---------------- Obsidian layer ----------------

const { Plugin, ItemView, PluginSettingTab, Setting, Modal, Events, MarkdownRenderer, Notice, setIcon } = obsidian;

const VIEW_TYPE = 'worktree-view';
const FILE_VIEW_TYPE = 'worktree-file-view';
const POLL_MS = 4000;
const ACTIVE_MS = 60 * 1000;
const CWD_INDEX_TTL_MS = 60 * 1000;

class WorktreeStore extends Events {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.subscribers = 0;
    this.intervalId = null;
    this.refreshing = false;
    this.state = null;
    this.slices = new Map();
    this.staleSince = null;
    this.lastError = null;
    this.baseShaCache = new Map(); // `${wtHead}:${mainHead}` -> merge-base sha [D8.6]
    this.freshCache = new Map();   // headSha -> commit time ms [6A]
    this.cwdIndex = null;
    this.cwdIndexAt = 0;
  }

  repoPath() {
    const configured = this.plugin.settings.repoPath.trim();
    return configured || this.plugin.app.vault.adapter.getBasePath();
  }

  // Refcounted lifecycle: polls only while a panel or file tab is open [6A, D8.9].
  acquire() { if (++this.subscribers === 1) this.start(); }
  release() { this.subscribers = Math.max(0, this.subscribers - 1); if (this.subscribers === 0) this.stop(); }

  start() {
    this.refresh();
    this.intervalId = window.setInterval(() => this.refresh(), POLL_MS);
    this.plugin.registerInterval(this.intervalId);
  }

  stop() {
    if (this.intervalId) { window.clearInterval(this.intervalId); this.intervalId = null; }
  }

  async refresh() {
    if (this.refreshing) return; // ponytail: skip-if-busy — ticks never overlap [2A]
    this.refreshing = true;
    try {
      const repo = this.repoPath();
      const wts = parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain']));
      if (!wts.length) throw new Error('no worktrees found');
      const main = wts[0];
      const base = main.branch || 'HEAD';
      const rows = [];
      for (const wt of wts) {
        if (wt.bare) { rows.push({ ...wt, isMain: false, changes: [], slice: wt.path, freshTs: null }); continue; }
        const isMain = wt.path === main.path;
        const status = await git(wt.path, ['status', '--porcelain', '-z']);
        let baseSha = '';
        if (!isMain && wt.branch) {
          const key = `${wt.head}:${main.head}`;
          if (!this.baseShaCache.has(key)) {
            this.baseShaCache.set(key, (await git(repo, ['merge-base', base, wt.branch])).trim());
          }
          baseSha = this.baseShaCache.get(key);
        }
        const diffTarget = isMain ? 'HEAD' : (baseSha || 'HEAD');
        const diff = parseNameStatus(await git(wt.path, ['diff', '--name-status', '-z', diffTarget]));
        const changes = unionChanges(diff, parseUntracked(status));
        if (!this.freshCache.has(wt.head)) {
          const ct = parseInt((await git(wt.path, ['log', '-1', '--format=%ct'])).trim(), 10);
          this.freshCache.set(wt.head, Number.isFinite(ct) ? ct * 1000 : null);
        }
        rows.push({
          ...wt, isMain, changes, diffTarget,
          freshTs: this.freshCache.get(wt.head),
          slice: rowSlice(wt, status, baseSha, isMain),
        });
      }
      this.updatePresence(rows);

      const changedRows = new Set();
      const newPaths = new Set(rows.map((r) => r.path));
      for (const r of rows) if (this.slices.get(r.path) !== r.slice) changedRows.add(r.path);
      for (const p of this.slices.keys()) if (!newPaths.has(p)) changedRows.add(p);
      this.slices = new Map(rows.map((r) => [r.path, r.slice]));
      this.state = { repo, base, main, worktrees: rows };

      const wasStale = this.staleSince;
      this.staleSince = null;
      this.lastError = null;
      if (changedRows.size || wasStale) this.trigger('change', changedRows);
      this.trigger('presence'); // dots + relative times patch every tick [D8.8]
    } catch (e) {
      // ponytail: background failures keep last-good state + stale hint [4A]
      this.staleSince = this.staleSince || Date.now();
      this.lastError = e;
      this.trigger('presence');
    } finally {
      this.refreshing = false;
    }
  }

  updatePresence(rows) {
    const now = Date.now();
    if (!this.cwdIndex || now - this.cwdIndexAt > CWD_INDEX_TTL_MS) {
      // ponytail: rebuilt at most once a minute — new agent sessions appear within 60s
      this.cwdIndex = buildCwdIndex(path.join(os.homedir(), '.claude', 'projects'));
      this.cwdIndexAt = now;
    }
    for (const r of rows) {
      const dir = this.cwdIndex.get(r.path);
      r.lastActivity = dir ? newestJsonlMtime(dir) : null;
    }
  }
}

function presenceInfo(row) {
  if (!row.lastActivity) return { cls: 'worktree-dot', text: '' };
  const age = Date.now() - row.lastActivity;
  return age < ACTIVE_MS
    ? { cls: 'worktree-dot worktree-dot-active', text: 'agent active' }
    : { cls: 'worktree-dot', text: `idle ${relativeTime(age)}` };
}

class WorktreeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.expandedPaths = new Set(); // survives re-renders — the v0.1 closure bug, fixed structurally
    this.rowEls = new Map();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Git worktrees'; }
  getIcon() { return 'git-branch'; }

  async onOpen() {
    const store = this.plugin.store;
    this.registerEvent(store.on('change', (changed) => this.renderRows(changed)));
    this.registerEvent(store.on('presence', () => this.patchPresence()));
    this.renderShell();
    store.acquire();
    if (store.state) this.renderRows(null);
  }

  async onClose() {
    this.plugin.store.release();
  }

  renderShell() {
    const el = this.contentEl;
    el.empty();
    this.rowEls.clear();
    const header = el.createDiv({ cls: 'nav-header worktree-header' });
    this.repoNameEl = header.createSpan({ cls: 'worktree-view-branch' });
    this.liveEl = header.createSpan({ cls: 'worktree-view-fresh' });
    const refreshBtn = header.createEl('button', { text: 'Refresh' });
    refreshBtn.onclick = () => this.plugin.store.refresh();
    this.staleEl = el.createDiv({ cls: 'worktree-stale' });
    this.staleEl.hide();
    this.listEl = el.createDiv();
    this.footerEl = el.createDiv({ cls: 'worktree-footer' });
  }

  renderRows(changedRows) {
    const state = this.plugin.store.state;
    if (!state) return;
    this.repoNameEl.setText(path.basename(state.repo));
    const keep = new Set();
    for (const row of state.worktrees) {
      keep.add(row.path);
      let elInfo = this.rowEls.get(row.path);
      if (!elInfo || !changedRows || changedRows.has(row.path)) {
        const rowEl = elInfo ? elInfo.rowEl : this.listEl.createDiv({ cls: 'worktree-view-item' });
        rowEl.empty();
        elInfo = this.buildRow(rowEl, row, state);
        this.rowEls.set(row.path, elInfo);
      } else {
        elInfo.row = row;
      }
      this.listEl.appendChild(elInfo.rowEl); // appendChild keeps/repairs ordering
    }
    for (const [p, info] of this.rowEls) {
      if (!keep.has(p)) { info.rowEl.remove(); this.rowEls.delete(p); }
    }
    this.patchPresence();
  }

  buildRow(rowEl, row, state) {
    const info = { rowEl, row };
    const head = rowEl.createDiv({ cls: 'worktree-view-row' });
    head.createSpan({ cls: 'worktree-chevron', text: this.expandedPaths.has(row.path) ? '▾' : '▸' });
    const label = row.bare ? '(bare)' : row.branch || `(detached @ ${(row.head || '').slice(0, 8)})`;
    const flags = [row.locked && 'locked', row.prunable && 'prunable'].filter(Boolean);
    head.createSpan({ cls: 'worktree-view-branch', text: flags.length ? `${label} [${flags.join(', ')}]` : label });
    info.dotEl = head.createSpan({ cls: 'worktree-dot' });
    info.presenceEl = head.createSpan({ cls: 'worktree-view-fresh' });
    head.createSpan({ cls: 'worktree-spacer' });
    info.freshEl = head.createSpan({ cls: 'worktree-view-fresh' });
    const folderBtn = head.createSpan({ cls: 'worktree-view-folder-btn' });
    setIcon(folderBtn, 'folder-open');
    folderBtn.setAttribute('aria-label', 'Reveal in system file explorer');
    folderBtn.onclick = (ev) => { ev.stopPropagation(); require('electron').shell.openPath(row.path); };
    rowEl.createDiv({ cls: 'worktree-view-meta', text: row.path });

    const details = rowEl.createDiv();
    if (this.expandedPaths.has(row.path)) this.buildDetails(details, row, state);
    head.onclick = () => {
      if (this.expandedPaths.has(row.path)) this.expandedPaths.delete(row.path);
      else this.expandedPaths.add(row.path);
      const fresh = this.plugin.store.state.worktrees.find((r) => r.path === row.path) || row;
      rowEl.empty();
      this.rowEls.set(row.path, this.buildRow(rowEl, fresh, this.plugin.store.state));
      this.patchPresence();
    };
    return info;
  }

  buildDetails(el, row, state) {
    if (row.changes.length === 0) {
      el.createDiv({ cls: 'worktree-view-meta', text: row.isMain ? 'No uncommitted changes.' : `No changes vs ${state.base}.` });
    }
    for (const change of row.changes) {
      const fileRow = el.createDiv({ cls: 'worktree-view-file' });
      fileRow.createSpan({ cls: `worktree-view-status worktree-view-status-${change.status}`, text: change.status });
      fileRow.createSpan({ text: change.path });
      fileRow.onclick = async (ev) => {
        ev.stopPropagation();
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({
          type: FILE_VIEW_TYPE,
          active: true,
          // Untracked files have no diff — open them in preview.
          state: { wtPath: row.path, file: change.path, diffTarget: row.diffTarget, label: row.branch || row.path, mode: change.status === '?' ? 'preview' : 'diff' },
        });
      };
    }
    if (!row.isMain && row.branch && !row.bare) {
      const btn = el.createEl('button', { cls: 'worktree-merge-btn', text: 'Merge & prune ⚠' });
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        try {
          const decision = await runPreflight(state.main.path, state.base, row);
          new MergeModal(this.app, this.plugin, row, decision).open();
        } catch (e) {
          new Notice(`Preflight failed: ${e.message}`, 8000);
        } finally {
          btn.disabled = false;
        }
      };
    }
  }

  patchPresence() {
    const store = this.plugin.store;
    const state = store.state;
    if (!state) {
      if (store.staleSince) {
        this.staleEl.setText(`Cannot read repo: ${store.lastError ? store.lastError.message : 'unknown error'}`);
        this.staleEl.show();
      }
      return;
    }
    if (store.staleSince) {
      this.staleEl.setText(`stale since ${relativeTime(Date.now() - store.staleSince)} ago — ${store.lastError ? store.lastError.message : ''}`);
      this.staleEl.show();
      this.liveEl.setText('○ stale');
    } else {
      this.staleEl.hide();
      this.liveEl.setText('● live');
    }
    let active = 0;
    let files = 0;
    for (const row of state.worktrees) {
      const info = this.rowEls.get(row.path);
      const isActive = row.lastActivity && Date.now() - row.lastActivity < ACTIVE_MS;
      if (isActive && !row.isMain) active++;
      if (!row.isMain) files += row.changes.length;
      if (!info || !info.dotEl) continue;
      const p = presenceInfo(row);
      info.dotEl.className = p.cls;
      info.presenceEl.setText(p.text);
      info.freshEl.setText(row.freshTs ? `updated ${relativeTime(Date.now() - row.freshTs)} ago` : '');
    }
    this.footerEl.setText(`${active} agent${active === 1 ? '' : 's'} active · ${files} file${files === 1 ? '' : 's'} changed across ${Math.max(0, state.worktrees.length - 1)} worktrees`);
  }
}

class MergeModal extends Modal {
  constructor(app, plugin, row, decision) {
    super(app);
    this.plugin = plugin;
    this.row = row;
    this.decision = decision;
  }

  onOpen() {
    const { contentEl } = this;
    const state = this.plugin.store.state;
    contentEl.createEl('h3', { text: 'Merge & prune' });
    contentEl.createDiv({ text: `${this.row.branch} → ${state.base} (fast-forward), then remove the worktree and delete the branch.` });
    contentEl.createDiv({ cls: 'worktree-view-meta', text: this.row.path });
    if (this.row.lastActivity) {
      // Advisory only — an idle-looking session may still hold this worktree [D8.8]
      contentEl.createDiv({
        cls: 'worktree-view-meta',
        text: `Last agent activity ${relativeTime(Date.now() - this.row.lastActivity)} ago — an idle-looking session may still hold this worktree as its working directory.`,
      });
    }
    if (!this.decision.ok) {
      contentEl.createDiv({ cls: 'worktree-view-error', text: this.decision.reason });
    }
    const btns = contentEl.createDiv({ cls: 'modal-button-container' });
    const execute = async (commitFirst) => {
      btns.querySelectorAll('button').forEach((b) => { b.disabled = true; }); // double-click guard
      try {
        await mergeAndPrune(state.main.path, state.base, this.row, { commitFirst });
        new Notice(`Merged ${this.row.branch} and pruned its worktree.`);
      } catch (e) {
        new Notice(`Merge failed: ${e.message}`, 10000);
      }
      this.close();
      this.plugin.store.refresh();
    };
    if (this.decision.ok) {
      const ok = btns.createEl('button', { cls: 'mod-cta', text: 'Merge & prune' });
      ok.onclick = () => execute(false);
    } else if (this.decision.canCommitThenMerge) {
      const ok = btns.createEl('button', { cls: 'mod-cta', text: 'Commit all & merge' });
      ok.onclick = () => execute(true); // [D8.7]
    }
    const cancel = btns.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class WorktreeFileView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return FILE_VIEW_TYPE; }
  getDisplayText() { return this.state ? `${path.basename(this.state.file)} @ ${this.state.label}` : 'Worktree file'; }
  getIcon() { return 'git-compare'; }

  async onOpen() {
    const store = this.plugin.store;
    store.acquire(); // file tabs keep the poll alive too [D8.9]
    this.registerEvent(store.on('change', (changed) => {
      if (this.state && changed.has(this.state.wtPath)) this.render();
    }));
  }

  async onClose() {
    this.plugin.store.release();
  }

  async setState(state, result) {
    this.state = state;
    await this.render();
    return super.setState(state, result);
  }

  getState() { return this.state; }

  async render() {
    const el = this.contentEl;
    el.empty();
    const { wtPath, file, mode } = this.state;
    const storeState = this.plugin.store.state;
    const row = storeState ? storeState.worktrees.find((r) => r.path === wtPath) : null;
    if (storeState && !row) {
      el.createDiv({ cls: 'worktree-view-meta', text: 'This worktree no longer exists (merged or removed).' });
      return;
    }
    const diffTarget = (row && row.diffTarget) || this.state.diffTarget || 'HEAD';

    const header = el.createDiv({ cls: 'worktree-file-header' });
    header.createSpan({ cls: 'worktree-view-branch', text: file });
    const toggle = header.createEl('button', { text: mode === 'diff' ? 'Show preview' : 'Show diff' });
    toggle.onclick = () => {
      this.state.mode = mode === 'diff' ? 'preview' : 'diff';
      this.render();
    };

    const body = el.createDiv();
    if (mode === 'diff') {
      let diff;
      try {
        diff = await git(wtPath, ['diff', diffTarget, '--', file]);
      } catch (e) {
        body.createDiv({ cls: 'worktree-view-error', text: e.message });
        return;
      }
      const pre = body.createEl('pre', { cls: 'worktree-diff' });
      for (const line of diff.split('\n')) {
        const cls =
          line.startsWith('+') ? 'worktree-diff-add' :
          line.startsWith('-') ? 'worktree-diff-del' :
          line.startsWith('@@') ? 'worktree-diff-hunk' : '';
        pre.createDiv({ cls, text: line || ' ' });
      }
    } else {
      const abs = path.join(wtPath, file);
      let content;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        body.createDiv({ cls: 'worktree-view-error', text: `Cannot read ${abs} (deleted in this worktree?)` });
        return;
      }
      if (file.endsWith('.md')) {
        const md = body.createDiv({ cls: 'markdown-rendered' });
        await MarkdownRenderer.render(this.app, content, md, abs, this);
      } else {
        body.createEl('pre', { cls: 'worktree-diff', text: content });
      }
    }
  }
}

class WorktreeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('Repository path')
      .setDesc('Absolute path to the git repository. Leave empty to use the vault folder.')
      .addText((text) =>
        text
          .setPlaceholder('/path/to/repo')
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (value) => {
            this.plugin.settings.repoPath = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
}

module.exports = class WorktreeViewerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ repoPath: '' }, await this.loadData());
    this.store = new WorktreeStore(this);

    this.registerView(VIEW_TYPE, (leaf) => new WorktreeView(leaf, this));
    this.registerView(FILE_VIEW_TYPE, (leaf) => new WorktreeFileView(leaf, this));
    this.addSettingTab(new WorktreeSettingTab(this.app, this));

    this.addRibbonIcon('git-branch', 'Open git worktrees', () => this.activateView());
    this.addCommand({
      id: 'open-worktree-view',
      name: 'Open git worktrees',
      callback: () => this.activateView(),
    });
  }

  onunload() {
    this.store.stop();
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = existing[0] || this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
