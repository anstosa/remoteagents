---
status: accepted
date: 2026-08-28
---

# Worktrees are discovered from git; operator state is keyed by Project and path

Until now every checkout the console knew about was a `worktrees[]` entry in the config file, keyed by a hand-written `id` that also keyed notes, bookmarks, prompt queues and history, with `saveKey` to share some of that state across checkouts of one repository. The console is gaining git-worktree workflows — create a branch checkout, launch an agent in it, remove it when merged — where checkouts appear and disappear many times between config edits. We decided that config declares *Projects* (repositories) only; their *Worktrees* come from `git worktree list` and are never declared; Project-wide state (notes, bookmarks, saved prompts) is keyed by the Project id and Worktree-scoped state (queued prompts, history, last-used Launch profile, pin, custom label) by `<projectId>:<realpath>`; and which idle Worktrees keep a tab is a per-Worktree pin stored in `.data` rather than a config flag. We chose this because a checkout's lifetime is now shorter than the config file's, so anything true of one checkout has to live somewhere the console can write.

## Considered options

- **Keep declaring worktrees in config and add a UI that edits the file.** Every Add/Remove becomes a config write-back with validation and a restart-free reload the server does not have, and a worktree created in a terminal stays invisible until someone declares it.
- **Key worktree state by branch instead of path.** State would follow a branch re-created elsewhere, but detached HEAD has no key and a `git switch` in the main checkout would silently swap its history and queue. The path is the worktree's identity for as long as it exists; the branch is already recorded where it matters (review tours).
- **Auto-discover repositories too** (scan a directory for `.git`). Rejected: a Project carries trusted stack commands and push actions, which must be opt-in per repository.
- **`pinned` on the Project, applying to all of its worktrees.** Simplest, but a Project with several idle checkouts either shows every one or none, the operator has no say per worktree, and a checkout created from a terminal would either flood or hide the tab bar.

## Consequences

- **Config and data both migrate.** `worktrees[]` → `projects[]`, and every `.data` store re-keys: `saveKey`/`id` → `<projectId>`, `worktree:<id>` → `<projectId>:<realpath of that entry's checkout>`. Entries that were separate checkouts of one repository collapse into one Project. This is the part that is hard to reverse.
- **Mutable Worktree state lives in `.data`**: pin, custom label, last-used Launch profile, queued prompts, history. Operator-owned stack commands and preview endpoints may instead be configured by checkout path in `projects[].worktreeOverrides`; these settings never declare or discover a Worktree. Observation never deletes state; only a console-initiated Remove does, so a checkout that vanishes from git (unmounted, deleted by hand) leaves its records until an explicit prune.
- **The main worktree is the only one whose path may differ between the console and the host.** Under Docker `hostPath` maps it; linked worktrees are taken exactly as git prints them and must be mounted at the same absolute path (already the documented rule). An unmounted one is `prunable` and hidden — and `git worktree prune` must never run automatically, because from inside the container it would delete metadata for a checkout that exists on the host.
- **Wire ids carry the path.** `/api/worktrees/:id` takes the URL-encoded `<projectId>:<realpath>`; the web treats it as opaque. Browser-local per-worktree preferences keyed by the old ids reset once.
- **Identity is the common git directory**, so a Project may be configured through any of its checkouts, including a bare repository, and two Projects cannot point at the same repository.
