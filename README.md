# Worktree Viewer — mission control for git worktrees in Obsidian

Watch AI agents (or anyone) work in git worktrees, live, from inside your vault — then accept their work with one click.

Every Obsidian git plugin versions your vault. This one inverts that: your vault becomes the cockpit for repos changing beneath it. Built for the parallel-agent era — run several Claude Code sessions in worktrees and watch their edits stream in while you write.

## What it does

- **Live worktree panel** — every worktree of your repo, refreshed every 4s while open (and fully idle when closed). No flicker: rows re-render only when *their* state changes, and your own typing doesn't redraw agent rows.
- **Agent presence dots** — a pulsing dot on any worktree where a Claude Code session is actively writing, read from the session's own transcripts. "idle 4m" when it stops.
- **Changed files per worktree** — diffed against the merge-base (no phantom changes after siblings merge), untracked files included, click any file for a colored diff or a fully rendered preview of the worktree's version of the note.
- **Commit all & create PR** — one click commits the agent's uncommitted work, pushes the branch, and opens a pull request (via `gh`, with a GitHub compare-page fallback). Nothing is deleted; the worktree stays until the PR merges.
- **Safe by construction** — all polling uses `--no-optional-locks` so the plugin never contends with your agents' own git operations.

## Install

**Via [BRAT](https://github.com/TfTHacker/obsidian42-brat)** (recommended): add `sjwinkler19/obsidian-worktree-viewer` as a beta plugin.

**Manual:** download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/worktree-viewer/`, then enable it in Settings → Community plugins.

## Setup

Settings → Worktree Viewer → **Repository path**: the absolute path of the git repo whose worktrees you want to watch (defaults to the vault folder). Works when the vault is a subfolder of the repo. Then open the panel via the git-branch ribbon icon.

Requirements: desktop only; `git` on PATH; [`gh`](https://cli.github.com) (optional — enables direct PR creation, otherwise you get the GitHub compare page).

## Development

Plain JavaScript, no build step, zero dependencies. Tests use node's built-in runner:

```
node --test
```

The suite includes scratch-repo integration tests that exercise real git worktrees, pushes, and the PR sequence against a local bare origin.

## License

[MIT](LICENSE) © Sebastian Winkler
