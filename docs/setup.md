# Remote Agent Console setup

## Security boundary

This is a **single trusted operator** console: terminal and prompt access execute code as the Unix account running the server. It binds only to loopback; never expose it directly to the Internet. Loopback HTTP is supported for local evaluation only. Publish the console beyond the local machine only through an HTTPS reverse proxy or tunnel that preserves the configured Host and Origin.

## Prerequisites

Linux with `/proc`, tmux, Node 22+ (Node 24 is supported), pnpm, a C/C++ build toolchain for `node-pty`, and an existing agent CLI (Codex by default). Configure each CLI the console launches under [`adapters`](#adapters).

```bash
pnpm install
cp config/remote-agent-console.example.json ~/remote-agent-console.json
# The starter configuration is valid scratch-only loopback HTTP.
node -e "require('argon2').hash('choose-a-long-password',{type:require('argon2').argon2id}).then(console.log)"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export RAC_PASSWORD_HASH='paste-the-argon2id-hash'
export RAC_SESSION_SECRET='paste-unique-32+-random-base64url-bytes'
export RAC_INSTANCE_STATUS_SECRET='paste-shared-32+-random-base64url-bytes'
export RAC_CONFIG="$HOME/remote-agent-console.json"
pnpm config:check "$RAC_CONFIG"
pnpm build
pnpm start
```

Open `http://127.0.0.1:8787`. Leave `projects` empty or omit it entirely to
launch scratch agents without configuring a repository. By default a scratch
agent starts in the console's home directory; set the top-level
`scratchDirectory` (an absolute path) to launch it elsewhere. The account home
the shell exports is unaffected — only the working directory changes. Before
publishing the console, replace `publicOrigin` with its canonical HTTPS origin.

When `remoteServers` connects multiple console instances, configure the same
separately generated `RAC_INSTANCE_STATUS_SECRET` on every peer. Keep each
instance's `RAC_SESSION_SECRET` unique: it signs browser sessions and must not
be reused as the federation credential. The status API exposes only the
server's published name and icon plus aggregate question, completed, idle, or
unavailable attention. It rejects unsigned or stale peer requests.

To run the console and its managed tmux/Codex sessions in Docker instead, see
[the Docker Compose guide](docker.md).

## Adapters

Each agent CLI the console launches is configured once under `adapters`, keyed
by kind (`codex`, `omx`, `claude`, `pi`, `opencode`). The console launches a kind by
prepending its `program` to the adapter's own arguments and appending the
operator's, so a checkout never chooses a program — adapter configuration is
global:

```json
{
  "adapters": {
    "codex": { "program": "/usr/local/bin/codex" },
    "claude": { "program": "/usr/local/bin/claude", "args": ["--model", "opus"], "env": { "SOME_VAR": "1" } }
  }
}
```

Each entry is `{ program, args?, env?, setup?, teardown?, updates? }`. `program` must be an
**absolute path to a real executable** (not a version-manager shim that needs a
shell); `args` (≤64) and `env` (names `^[A-Za-z_][A-Za-z0-9_]*$`) are the
operator's additions. Values are never shell-expanded — the console shell-quotes
them — so there are no placeholders, and `env` is not a place for secrets.
Configuring zero adapters — an empty or omitted block — is valid: the console
then only observes hand-started agents. Adding a kind whose program is missing
or not executable does not stop the server; that kind shows as unavailable in
**Global settings → Agents** with the reason, and every other kind still
launches. `pnpm config:check` reports the same non-fatal warning.

`setup` and `teardown` are optional shell-interpreted lifecycle commands for
host- or operator-specific shims. `setup` runs in the launched pane through the
same login shell as the agent, in the launch directory (the worktree for a
worktree launch, the home directory for Scratch), before the program; a non-zero
exit stops the agent from ever starting — the failure is visible in the pane.
`teardown` runs after the console stops a running agent of the kind (Stop, Sleep,
Restart), in the stopped agent's workspace, best-effort: a failure is logged and
never blocks the stop. Unlike `setup`, `teardown` runs through the tmux server's
`sh` with the server's environment, not your login shell, so it does not see
profile-only `PATH` entries — keep it to absolute paths and plain commands. On
Restart both fire, so make the commands idempotent.

`updates` is an optional all-or-nothing object with three trusted shell commands:
`current` prints the installed version, `latest` prints the newest upstream
version, and `run` performs the update. The first non-empty output line from each
version command is compared exactly. Global settings shows the installed version
beside the agent, offers **Update** when the two values differ, and aggregates any
available agent update into a purple dot on the settings gear. Checks are cached
for 15 minutes; failed checks do not expose shell output to the browser.

Use adapter launch settings to disable each CLI's own startup updater once this
surface is configured. Codex accepts
`"args": ["-c", "check_for_update_on_startup=false"]`; OMX should receive the
same Codex argument plus `"env": { "OMX_AUTO_UPDATE": "0" }`. The explicit
`updates.run` command remains available even though launch-time checks are off.

### OMX

OMX (oh-my-codex) is its own kind, configured under `adapters.omx` with the real
OMX executable — for a mise install that is `node_modules/.bin/omx` inside the
install, not the mise shim. Codex and OMX sit side by side, so some worktrees
can run plain Codex and others OMX: the Launch menu offers both, and the console
remembers which one each worktree used last. The console launches OMX with
`--direct` (OMX's direct policy, which runs the Codex TUI in the pane and manages
no HUD panes) and forwards Continue and Bookmark resumes as `resume --last` and
`resume <id>`; `--direct` and `--tmux` are reserved, so a copy in `args` is
dropped with a boot warning. An OMX pane is badged OMX, the plain-Codex team
workers OMX spawns stay hidden from the dashboard, and Bookmarks stay pinned to
the kind they were taken under.

The Codex-only features — review tour, ChatGPT accounts, update advisor, the
app-server command catalog — still read `adapters.codex`; an OMX-only
configuration does without them. A `codex` entry whose program is actually OMX
(the pre-split configuration) still launches, but as the wrong kind; the console
warns at boot and in `pnpm config:check`.

### OMX on ZFS

The console stops agents by killing their pane, which leaves OMX's session
pointer (`<worktree>/.omx/state/session.json`) pointing at a dead session. OMX's
own recovery needs `renameat2(RENAME_NOREPLACE)`, which ZFS lacks, so every
following launch aborts with `session_pointer_unusable`. Configure the pointer
cleanup as the OMX adapter's lifecycle commands:

```json
{
  "adapters": {
    "codex": { "program": "/usr/local/bin/codex" },
    "omx": {
      "program": "/absolute/path/to/omx",
      "setup": "rm -f .omx/state/session.json",
      "teardown": "rm -f .omx/state/session.json"
    }
  }
}
```

`setup` alone is sufficient (it is the guaranteed pre-launch repair); `teardown`
keeps the checkout tidy between launches and, being keyed by kind, never fires
for a plain Codex stop. Relative paths in either command resolve against the
directory the command runs in — the worktree for `setup`, the stopped agent's
workspace for `teardown`.

The program is launched from an interactive zsh shell by default. Set
`RAC_INTERACTIVE_SHELL` for container or direct sessions and
`RAC_HOST_INTERACTIVE_SHELL` for host-tmux sessions. Absolute zsh and bash paths
are supported; each loads the operator's normal `.zshenv`/`.zshrc` or `.bashrc`
before starting the agent. Set `RAC_HOST_PATH` to a complete PATH when host
commands require executables outside the host shell's normal startup
environment.

When `adapters.codex` is configured it also becomes the Codex binary the review
tour, ChatGPT account management, and the update advisor use; `RAC_CODEX_BIN`
overrides it. With neither set, those Codex-only features report unavailable
rather than spawning a bare `codex` from `PATH`. The **Global settings** flyout
shows the ChatGPT accounts section only when `adapters.codex` is configured.

The console remembers the last kind launched in each worktree (and in Scratch)
and offers it first next time; with a single configured kind that is simply that
kind.

### Claude Code

```json
{ "adapters": { "claude": { "program": "/usr/local/bin/claude" } } }
```

With `adapters.claude` configured, launching Claude Code from the console gives
accurate Attention state, Enter-submitted prompts, safe interrupts, and Bookmarks
with titles. The console never touches anything under `~/.claude`: on every launch
and resume it passes `--settings` pointing at a console-owned file it renders at
boot into `<RAC_ADAPTER_FILES_DIR ?? .data/adapters>/claude/hooks.json`. That file
**only adds hooks** — Claude merges hook entries across settings levels, so your
own settings are unchanged. The hooks map Claude's lifecycle events to the
console's Attention states by running `scripts/hooks/rac-attention`, which writes
the tmux pane options the console polls. Do not put `--settings`, `--continue`,
`--resume`, `--session-id`, `-p`/`--print`, `--bare`, or `--safe-mode` in
`adapters.claude.args`; the console composes those itself and drops them with a
boot warning.

To get the same state and Bookmarks for Claude sessions you start **by hand**
(the console reads a hookless session as permanently *finished* and offers it no
Bookmarks), add the same script as an optional dotfile hook in your own
`~/.claude/settings.json`, for example on `UserPromptSubmit`:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "timeout": 5, "command": "/absolute/path/to/remoteagents/scripts/hooks/rac-attention working" } ] } ] } }
```

`rac-attention` exits 0 doing nothing unless it is inside a tmux pane and a tmux
binary resolves (`$RAC_TMUX_BIN`, else `tmux` on `PATH`), so it stays harmless in
shared dotfiles on hosts without the console.

**Known limitations.** A directory Claude has never opened shows its trust dialog
on first launch — the console never pre-accepts it, so UI-created worktrees hit it
once. A hookless session (see above) reads as *finished* and has no Bookmarks. Any
text already in the input box concatenates with a console paste. Under the
[host bridge](docker.md), set `RAC_HOST_REPOSITORY` to the host checkout path;
without it `claude` (and `pi`) show as unavailable, because the injected file paths
must be the ones the host-side agent sees. The console writes the rendered files
under `<RAC_HOST_REPOSITORY>/.data/adapters` (or `RAC_ADAPTER_FILES_DIR`); that
directory must resolve to the same bytes inside the container and on the host — a
bind mount at the same path, or an explicit shared `RAC_ADAPTER_FILES_DIR` — so the
host-side agent reads the file the container wrote.

## Projects

A **Project** is a git repository the console manages. Configure each one once
under `projects`; its **Worktrees** are discovered from `git worktree list` and
are never declared, so a checkout created in a terminal appears on the dashboard
within a tick — no config edit or restart.

```json
{
  "projects": [
    {
      "id": "example",
      "label": "Example",
      "path": "/home/me/code/example",
      "worktreesDirectory": "../example-worktrees",
      "commands": { "start": "docker compose up -d", "status": "test -n running" },
      "newTask": "detach && new {taskId}",
      "push": { "label": "Finish and PR", "prompt": "$finish" },
      "port": 3000,
      "hostname": "app.example.com"
    }
  ]
}
```

- `id` — `[A-Za-z0-9_-]{1,80}`, the key for Project-wide state (`agent` and
  `scratch` are reserved). `label` defaults to `id`.
- `path` — **any checkout of the repository** (a Linked worktree or a bare
  repository included). Its identity is the realpath of the common git
  directory, so two Projects pointing at the same repository are refused as
  duplicates. A `path` that is missing or not a git checkout at boot loads the
  Project as unavailable with a boot warning rather than stopping the server.
- `worktreesDirectory` — where the console will create new Worktrees; the
  default is a `../<basename>-worktrees` sibling of the Main worktree, and a
  relative path resolves against it. Absolute paths are allowed.
- `commands` (`start`/`stop`/`build`/`restart`/`migrate`/`status`), `newTask`
  and `push` are Project-wide. `newTask` adds a **New Task** action, uses
  `{taskId}` for an 8-character URL-safe random ID, and is enabled only when the
  Worktree is clean and fully pushed. `push` overrides the default
  **Commit/Push** action (which queues `review, commit, and push`).
- `port` + `hostname` (both or neither) publish one preview URL per Project,
  `https://<hostname>` proxied to `127.0.0.1:<port>`.

The console launches an agent in a Worktree by Adapter kind (see
[Adapters](#adapters)); a Project never names a program. Every `git worktree
list` checkout appears automatically: the Main worktree is git's first entry, a
bare entry is never a Worktree, a Stale (git-prunable) checkout is hidden, a
git-locked one is flagged, and a detached HEAD is labelled by its short SHA.
Use **Rename worktree** from a launch row or agent menu to replace that generated
Project/branch label with a stable operator name such as `Dave`. The alias is
stored in `.data/worktrees.json`, follows the checkout path across launches, and
does not rename the branch or directory. **Use branch name** clears the alias and
restores the generated label.

### Creating Worktrees

The `+` launcher lists one section per Project. Each header carries a **New
worktree…** control that opens a dialog with two modes:

- **New branch** — a branch name plus a base picked from the Project's branches,
  pre-selected to its default branch (`origin/HEAD` when the remote publishes one,
  else the checkout's current branch). A branch another Worktree already holds is
  still offered here — the default branch usually is one. The console creates the
  branch with `git worktree add --no-track -b <name> <path> <base>`.
- **Existing branch** — the same picker over the branches that can still be checked
  out: local branches checked out nowhere plus remote-only branches (marked); git
  creates the tracking branch for the latter.

The checkout is created under the Project's `worktreesDirectory` at a leaf named
for the branch (`/` flattened to `-`); you never type a path. The console pins
the new Worktree so it keeps its tab, gives it an idle shell, and — unless you
clear **Launch agent** — launches the Project's last-used kind in it. The
Worktree is created even if that launch fails; the launch error is reported and
the tab stands. Refusals (an existing branch name, an unresolvable base, a branch
already checked out elsewhere, or a target path that exists) are reported before
git runs.

### Removing Worktrees

**Remove** appears on an idle Worktree's power menu and beside its launcher row.
It is hidden on the Main worktree and disabled on a git-locked one. It is refused
(a clear message, never a forced removal) while an Agent or a stack command runs
in that Worktree. The dialog shows fresh facts read at that moment — the number
of uncommitted changes, whether the branch is pushed and merged, and how far it
is ahead of or behind its upstream:

- A tree with uncommitted changes can only be removed after you tick **Discard
  uncommitted changes**; git is then run with `--force` (never `-f -f`). An
  unpushed branch is only a warning, never a block.
- **Also delete branch `<name>`** is off by default and absent on a detached
  HEAD. When the branch is neither pushed nor merged the dialog warns that
  deleting it discards its commits for good, but the tick stays yours to make.
  It force-deletes the branch after the checkout is removed; if that delete
  fails, the removal still stands and the failure is reported.

Removing a Worktree kills its idle shell, removes the checkout, and deletes its
console records (pin, last-used kind, queued prompts, prompt history, sleeping
tab). It never touches the Project-scoped bookmarks and notes its siblings share.

### Pruning stale Worktrees

A checkout whose directory is gone (git calls it *prunable*) is hidden rather
than shown, and a console record left behind by a checkout git no longer lists is
kept, never deleted on its own. When either exists, the Project header shows
**N stale · Prune**. Prune is explicit and per Project: it runs `git worktree
prune` and deletes the orphaned console records, listing every stale path in the
confirm first. Under the Docker bridge a host checkout the container does not
mount can *look* stale from inside the container — the confirm warns you, so
prune only what you know is truly gone.

### Shared bookmarks and notes

Chat bookmarks, sticky notes and saved prompts belong to the **Project** and are
shared automatically across all of its Worktrees, so related checkouts resume
the same chats and use the same notes with no configuration. Queued prompts and
prompt history stay per-Worktree. Scratch agents derive their own persistence
group from the scratch workspace, so scratch agents opened in the same directory
share entries across restarts; exact bookmark resume requires a configured
Project (scratch agents have none).

### Migrating from `worktrees[]`

Upgrading from a `worktrees[]` configuration is automatic: **start the console
once.** On the first boot it detects the legacy shape (a `worktrees` array, or a
`command`/`newAgentCommand`/`launch`/`resumeCommand` key) and, in one eager pass
driven by the config, rewrites the config to `projects[]` + `adapters.codex` and
re-keys every `.data` store to the Projects model (notes and bookmarks by
Project; saved prompts, queued prompts, history, review tours, pins and labels by
Worktree). Distinct legacy `worktrees[]` labels are preserved as Worktree aliases
when several entries collapse into one Project.
Each rewritten file — the config included — gets a sibling `*.pre-projects.bak`
holding the original, so the change is revertable; an existing backup is never
overwritten. The boot log prints one report of what changed. A config already in
the new shape runs nothing and reads no data file, so the migration is a
one-time event.

Preview the plan before you restart with the dry run, which writes nothing:

```sh
pnpm config:check "$RAC_CONFIG"        # prints the migration plan for a legacy file
```

If the config lives somewhere the server cannot write at boot — a read-only
systemd or Docker deployment — run the migration once yourself, as a user who can
write it, then restart:

```sh
pnpm config:migrate "$RAC_CONFIG"      # migrates in place without booting
```

The migration **refuses to boot** with every problem listed and nothing written
when anything is ambiguous or unwritable — a bare program name that resolves to a
shell alias or is not on `PATH`, worktree entries that disagree on the launch
binary, a `launch` template placeholder, both `worktrees` and `projects` present,
a corrupt `.data` file, or a target the server cannot write. Fix an unwritable
target by adding its path to the systemd unit's `ReadWritePaths` or mounting it
read-write under Docker, by moving the config somewhere writable and pointing
`RAC_CONFIG` at it, or by running `pnpm config:migrate` as above. To undo a
migration, restore each `*.pre-projects.bak` over its file and restart.

The default server listener is `127.0.0.1:8787`; `/healthz` is loopback-only and reveals only `{ "ok": true }`. Do not put passwords, prompts, session cookies, CSRF tokens, or WebSocket tickets in configuration or logs.

## Browser capabilities

The console can be installed as a browser app. Select **Enable alerts** in the
console to grant notification access; mobile browsers require that permission
request to come from a tap. Alerts are raised when the open console detects an
agent changing from working to ready. Voice input is
shown only in browsers that implement the Web Speech API; microphone access is
restricted by the console's permissions policy and is never required to use
the prompt field.

Browser notifications are not server push notifications: when mobile operating
systems suspend or terminate the console, it cannot poll tmux for changes. For
iOS, install the console to the Home Screen and use iOS 16.4 or later before
enabling alerts.

If a worktree has a GitHub `origin` remote and the host has GitHub CLI
credentials (or `RAC_GITHUB_TOKEN`), the console can show a link to its open
pull request. The lookup is read-only and its result is cached briefly.

## Operational checks

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. On a disposable Linux host, start Codex in tmux and confirm it appears; start an ordinary shell/HUD pane and confirm it does not. Verify the configured active worktree is not duplicated, prompt Tab/newline/Ctrl+Enter behavior, and explicitly confirm the session-scoped terminal warning before using terminal access.
