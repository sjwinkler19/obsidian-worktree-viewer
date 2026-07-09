# TODOS

## v0.3: Per-note divergence badges ("haunted vault")
- **What:** Badge on any open note that differs in one or more worktrees ("2 agents changed this note"); hover names branches; click opens side-by-side (main vs worktree rendered markdown). Per-note accept (`git checkout <branch> -- <file>`) as a smaller write than branch merge.
- **Why:** The strongest idea from the office-hours cross-model review (2026-07-08) — agent work surfaces on the notes you're already reading, not in a panel. Nobody has built this; the one repo that tried is empty.
- **Pros:** The novel UX; the demo that makes strangers install it.
- **Cons:** Deep Obsidian API work (file-open hook, header decoration); per-file accepts can leave branches half-applied.
- **Context:** v0.2's WorktreeStore already computes per-worktree changed-file lists diffed against merge-base (D8.6) in per-row slices (D8.2) — the reverse index (vault-relative path → worktrees touching it) is a cheap byproduct. Vault-relative mapping must account for vault = repo subfolder (Telos/Telos).
- **Depends on:** v0.2 store shipped.

## ~~Rebase-and-merge for non-ff worktrees~~ (mostly moot as of v0.3.0)
> The accept action became "commit & create PR" (2026-07-08, user call) — GitHub handles
> non-ff merges, so the local rebase path only matters if a local-merge option ever returns.
- **What:** When main has moved since a worktree branched, offer rebase-onto-main then ff-merge, with `git merge-tree` (git ≥ 2.38) conflict pre-check; refuse on conflicts with the conflicting paths named.
- **Why:** With sequential agent merges, the second merge of the day is routinely non-ff — v0.2's refusal will fire regularly.
- **Pros:** Closes the loop for the multi-agent day fully inside Obsidian.
- **Cons:** Rebasing rewrites a branch's commits — the riskiest git write in the plugin; needs its own scratch-repo test suite.
- **Context:** v0.2 already computes merge-base per worktree (D8.6) and has the cockpit modal + preflight structure (D8.1/D8.7); this extends both. Check `git --version` ≥ 2.38 before offering.
- **Depends on:** v0.2 cockpit shipped; the non-ff refusal actually annoying in practice.

## Multi-repo support
- **What:** Settings become a list of repo paths; panel renders one section per repo; store state keyed by repo.
- **Why:** The agent workflow spans repos (Telos today, this plugin's repo once git-inited).
- **Pros:** One dashboard for the whole fleet.
- **Cons:** Speculative until the single-repo limit is actually felt; more settings surface.
- **Context:** D8-series decisions already shape state per-worktree in slices with refcounted polling — keying by repo is a natural extension, not a rework.
- **Depends on:** wanting it. No technical blockers.

## Distribution pipeline (share with the world)
- **What:** LICENSE (MIT), versions.json, public GitHub repo, BRAT installability, community-store PR (obsidian-releases), GitHub Actions release workflow.
- **Why:** Premise 4 amendment (2026-07-08): "make sure we can eventually share this with the world." The worktree niche in the store is verified empty — first mover has a shelf life.
- **Pros:** Claims the niche; BRAT reaches the agent-workflow crowd immediately.
- **Cons:** Store review takes weeks; public users create support burden.
- **Context:** Eng review confirmed nothing in v0.2's architecture blocks submission (desktop-only is store-legal via isDesktopOnly; tests use node:test so the repo has zero dependencies). Store submission guidelines: no `var`, no innerHTML, sentence-case UI text — worth a compliance pass at PR time.
- **Depends on:** v0.2 proven in daily use; the itch.
