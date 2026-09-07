---
status: accepted
date: 2026-09-06
---

# Conversation names live in the agent's store; the console records only which ones it named

The console kept a Bookmark store — a title, a Conversation id and a kind, saved per Project in `.data/bookmarks.json` — so an operator could find a past Conversation and resume it. Every agent CLI the console runs now names its own Conversations (Claude Code's `/rename` and `--name`, Codex's `/rename`, Pi's `/name`) and lists and resumes them by that name, so the Bookmark duplicated a store the agent already keeps, and the two drifted: a title given in the console never reached the agent's picker, and a name given in the agent never reached the console. We decided that a Conversation's name lives in the agent's own store only. The console sets one by submitting the CLI's rename command into the pane and reads names back from the agent's files; it lists every Named conversation under the Project's Worktree directories; and it records for itself nothing but `{ kind, id, namedAt }` for the Conversations it named, so the quick list can be "what I named here" without the console owning a title. We chose this because Codex names every thread automatically and its store cannot tell a human name from a generated one: a record of *which* Conversations were named through the console is the smallest fact that recovers "my named conversations" without becoming a second name store.

## Considered options

- **Keep bookmarks and mirror them into the agent** (write the bookmark title as the agent's name on save). Two writers for one fact, and the console would have to write the agents' transcript, sidecar and state files — formats each CLI documents as internal.
- **List only human-named Conversations from the agent's store, with no console record.** Works for Claude (`custom-title` is distinct from `ai-title`) and Pi (only human names exist), fails for Codex, where every thread has a name and the store cannot say who gave it. The record exists for Codex; the two-tier list (console-named first, everything named behind More) follows from it.
- **Read the Codex state database** for names, recency and the archived flag. Rejected in favour of the rollout walk plus the `session_index.jsonl` sidecar: the database file is versioned by schema, its write-ahead log hides a running Codex's rows from an `immutable` reader, and the sidecar already carries every name for legacy and paginated threads alike.

## Consequences

- **The console never writes an agent's files.** A rename is a pasted slash command plus Enter, sent in the `finished` and `working` states and refused while a question dialog owns the keyboard; the console-named record is written only after the agent's store confirms the name.
- **Names cannot be cleared from the console**, because no CLI clears one. "Remove" forgets the console's record; the Conversation keeps its name and stays listed under "All named".
- **Recency is the agent's, not the file's.** Last-active is the last timestamped record of the transcript (Claude, Codex) or Pi's message-derived time; file mtime moves on bookkeeping and renames and is used only to pre-select candidates.
- **Automatic titles are names too** in the full list, marked automatic where the kind can tell (Claude, Pi) and unmarked for Codex.
- **A Conversation belongs to the Worktree directory it was started in and resumes there.** The console navigates to that Worktree rather than resuming in place, which sidesteps Codex's cwd prompt and Claude's cross-worktree resume behaviour.
- **Codex and OMX share one store**, so a listed Codex rollout resumes under the Worktree's remembered kind when that is codex or omx, else codex. This relaxes ADR 0005's "no cross-kind resume" for that pair only.
- **The Bookmark store is retired at boot**: the file's entries are logged once and the file renamed `.retired`; nothing converts them into records. ADR 0003's Project-wide keying carries over to the console-named record.
