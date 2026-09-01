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

Open `http://127.0.0.1:8787`. Leave `worktrees` empty or omit it entirely to
launch scratch agents without configuring a repository. Before publishing the
console, replace `publicOrigin` with its canonical HTTPS origin.

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
by kind (`codex`, `claude`, `pi`, `opencode`). The console launches a kind by
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

Each entry is `{ program, args?, env? }`. `program` must be an **absolute path
to a real executable** (not a version-manager shim that needs a shell); `args`
(≤64) and `env` (names `^[A-Za-z_][A-Za-z0-9_]*$`) are the operator's additions.
Values are never shell-expanded — the console shell-quotes them — so there are no
placeholders, and `env` is not a place for secrets. Configuring zero adapters is
valid: the console then only observes hand-started agents. Adding a kind whose
program is missing or not executable does not stop the server; that kind shows as
unavailable in **Global settings → Agents** with the reason, and every other kind
still launches. `pnpm config:check` reports the same non-fatal warning.

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

### Legacy worktree launch commands

Before `adapters`, each worktree defined its own `command` (and optional
`resumeCommand`). When `adapters.codex` is present it wins and these keys are
ignored with a one-time boot warning; the automatic migration folds them into
`adapters.codex`. Until a worktree's console is migrated, and only when no
`adapters` block is present, a worktree still launches through its own
`command`:

```json
{ "id": "my-project", "path": "/absolute/path/to/project", "command": "codex", "resumeCommand": "codex resume {threadId} -C ." }
```

A configured Codex worktree resumes an exact saved chat through its adapter
(`codex resume <id>`); no extra configuration is required. On the legacy path,
set `resumeCommand` only to override that composition — for example to pass extra
flags — and it must contain one `{threadId}` placeholder.

## Worktree options

An optional `newTask` command adds a **New Task** action for a worktree. It
uses `{taskId}` for an 8-character URL-safe random ID and is enabled only when
the working copy is clean and fully pushed. For example:

```json
{ "newTask": "detach && new {taskId}" }
```

Every agent flyout includes a prompt action that defaults to **Commit/Push**
and queues `review, commit, and push`. Override its button label and queued
prompt per worktree with `push`:

```json
{ "push": { "label": "Finish and PR", "prompt": "$finish" } }
```

With `adapters.codex` configured, worktrees launch by kind and need no
`command`. On the legacy path (no `adapters` block) every worktree must define a
`command`, which the console runs through the operator's interactive shell after
appending the adapter's arguments.

## Shared bookmarks and notes

Chat bookmarks and sticky notes use the worktree `id` as their persistence
group by default. Set the same optional `saveKey` on multiple worktrees to
share both lists. This is useful for related Git worktrees that should resume
the same Codex chats and use the same project notes:

```json
{ "id": "cora", "path": "/worktrees/cora", "command": "codex", "saveKey": "potato" }
{ "id": "owen", "path": "/worktrees/owen", "command": "codex", "saveKey": "potato" }
{ "id": "dave", "path": "/worktrees/dave", "command": "codex", "saveKey": "potato" }
```

Keep `saveKey` omitted for ordinary worktrees that should retain independent
bookmark and note groups. Changing a deployed worktree's key selects another
group; it does not move entries from the previous group automatically. Save keys
may contain letters, numbers, underscores, and hyphens and are limited to 80
characters.

Scratch agents also expose bookmarks and notes. The console derives their
persistence group from the scratch workspace, so scratch agents opened in the
same directory share entries across restarts. Exact bookmark resume requires a
configured worktree (scratch agents have none).

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
