# Remote Agent Console

A self-hosted browser console that watches and drives coding-agent CLIs running inside tmux panes on the host. This glossary fixes the words used across the server, the web app, and the config.

## Language

### Repositories and checkouts

**Project**:
A configured git repository. Owns everything that is true for the whole repository: label, stack commands, new-task and push actions, the Worktrees directory, and the preview URL.
_Avoid_: Repo entry, workspace

**Worktree**:
One checkout of a Project as reported by `git worktree list`, the main checkout included. Discovered from git, never declared in config.
_Avoid_: Workspace, worktree entry

**Main worktree**:
The checkout that holds the repository's git directory; git lists it first. A Project may be configured through any of its Worktrees, but only the Main worktree can differ between the console's view and the host's.
_Avoid_: Primary checkout, root worktree

**Linked worktree**:
Any other checkout of the Project, created with `git worktree add` by the console or by hand.
_Avoid_: Secondary worktree, branch checkout

**Pinned**:
A Worktree the operator keeps a tab for even while no Agent runs in it. Chosen per Worktree in the console; a Main worktree starts pinned, a Linked worktree does not.
_Avoid_: Favourite, sticky, visible

**Worktrees directory**:
Where the console creates a Project's new Worktrees. Says nothing about where Worktrees may live; git is the only source of what exists.
_Avoid_: Worktree root, checkout folder

**Stale worktree**:
A Worktree whose checkout is gone but whose trace remains: an entry git still lists with a missing directory, or console records for a Worktree git no longer lists. Cleared only by Prune.
_Avoid_: Prunable (git's word for one half of it), orphan, ghost

**Prune**:
The explicit per-Project action that clears a Project's Stale worktrees, both git's entries and the console's records. Never runs on its own.
_Avoid_: Cleanup (reserved for agents), garbage collection, auto-prune

**Scratch**:
A pane running an agent in a directory that belongs to no configured Project.
_Avoid_: Unconfigured worktree

### Agents

**Agent**:
A live tmux pane whose process tree runs an agent CLI. Carries a kind naming the Adapter that recognised it.
_Avoid_: Session, process

**Adapter**:
The server module that knows one agent CLI: how to launch and resume it, recognise its processes, read its state, submit prompts, and find its Conversations. It describes the agent; the console performs every action.
_Avoid_: Driver, plugin, agent type (use "kind" for the identifier, "Adapter" for the module)

**Conversation**:
The agent CLI's resumable transcript, identified by an id whose shape depends on the Adapter. What a resume brings back; distinct from the Agent, which is the live pane. It belongs to the Worktree directory it was started in and resumes there.
_Avoid_: Session (that word is reserved for tmux), thread, chat

**Conversation name**:
What the agent CLI calls a Conversation: the name a human gave it, or failing that the title the agent generated. The console only ever sets one through the agent CLI's own rename command.
_Avoid_: Bookmark, session name, summary

**Named conversation**:
A Conversation that has a Conversation name. What the console lists and offers to resume; a Conversation with only its id is not shown.
_Avoid_: Bookmark, saved chat, session

**Launch profile**:
The choice a worktree launches with: an Adapter plus whether the agent is Sandboxed. The Adapter is remembered per Worktree as the last one used; Sandboxed starts on whenever the Adapter offers it and is never remembered.
_Avoid_: Agent selection, launch preset

**Setup command / Teardown command**:
Operator-configured lifecycle commands on an adapter entry, keyed by kind. The setup command runs in the launched pane before the program and aborts the launch on failure; the teardown command runs best-effort in the agent's workspace after the console stops an agent of that kind. Home for host-specific repairs (the OMX-on-ZFS pointer cleanup, on the OMX Adapter's entry), not part of the Adapter module.
_Avoid_: Pre/post hooks (hooks name the agent-CLI mechanism Adapters inject)

**Sandboxed**:
An agent whose model-driven commands run with filesystem and network restrictions. The agent process itself is not confined: each Adapter sandboxes the commands its own way, natively where the CLI can, otherwise through a console-shipped extension.
_Avoid_: Isolated, jailed, wrapped

**Attention state**:
What an Agent needs from the operator right now: working, finished, or question.
_Avoid_: Status, activity

**Reported state**:
An Attention state the Agent announced itself. Takes precedence over Inferred state, and counts only while the Agent that announced it is still alive.
_Avoid_: Hook state, pushed state

**Inferred state**:
An Attention state the console derived from what the pane shows, used when the Agent has announced nothing.
_Avoid_: Scraped state, heuristic state

**Turn**:
One prompt and the Agent's complete response to it. What prompt history records; not every Adapter can recover one from the pane.
_Avoid_: Exchange, round, message pair

**Inline question**:
A question the Agent is asking that the console can answer on the operator's behalf by choosing one of its options, whether the Agent wrote it as a file, reported it through its pane (Claude's `AskUserQuestion` payload, ADR 0006), or only drew it on the pane.
_Avoid_: Choice list, structured question, parsed question, reported question (those name where it came from, not what it is)

### Operator state

**Console-named conversation**:
A Named conversation whose name was set through the console. The console remembers which Conversations these are and shows them first; the name itself stays with the agent.
_Avoid_: Bookmark, favourite, pinned conversation (Pinned is a Worktree word)

**Queued prompt**:
A prompt accepted while the Agent was busy, held durably until it can be dispatched.
_Avoid_: Pending prompt, backlog

**Note**:
Operator text kept with a Project, or with a Scratch directory, and edited in the console. The console's only saved text: what gets sent as a prompt, given a Schedule, or simply kept.
_Avoid_: Saved prompt (retired), sticky note, snippet

**Schedule**:
A standing instruction on a Note: when to run it, with which Adapter, and in which target (a Worktree, a directory Project, or Scratch). At most one per Note; carries the outcome of its last Run.
_Avoid_: Cron job, timer, recurring prompt

**Run**:
One firing of a Schedule. The console starts a fresh Conversation in the Schedule's own pane, launching one when there is none, and submits the Note's text as its first prompt. Recorded on the Schedule as launched, skipped, or failed.
_Avoid_: Execution, job, invocation

**Stack commands**:
The Project's trusted start/stop/build/restart/migrate/status commands, run in their own tmux session.
_Avoid_: Scripts, tasks
