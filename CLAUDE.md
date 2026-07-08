# Obsidian Worktree Plugin

A desktop-only Obsidian community plugin: live git-worktree dashboard in a sidebar (agent presence dots, per-worktree changed files, diffs/previews, guarded merge & prune). Plain JS, no build step, zero dependencies: `manifest.json`, `main.js`, `styles.css`. Tests: `node --test` (pure functions + scratch-repo merge integration). Under plain node, `main.js` exports the pure API; inside Obsidian it exports the Plugin.

Installed via symlink into two vaults: "The Brain of Sebastian" and "Telos" (`.obsidian/plugins/worktree-viewer`).

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
