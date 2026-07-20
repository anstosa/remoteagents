# Remote Agent Console setup

## Security boundary

This is a **single trusted operator** console: terminal and prompt access execute code as the Unix account running the server. It binds only to loopback; never expose it directly to the Internet. Publish it only through an HTTPS reverse proxy/tunnel that preserves the configured Host and Origin.

## Prerequisites

Linux with `/proc`, tmux, Node 22+ (Node 24 is supported), pnpm, a C/C++ build toolchain for `node-pty`, and an existing Codex executable. The server intentionally manages only Codex/OMX descendants of tmux panes.

```bash
pnpm install
cp config/remote-agent-console.example.json ~/remote-agent-console.json
# Edit every absolute path and the HTTPS publicOrigin.
node -e "require('argon2').hash('choose-a-long-password',{type:require('argon2').argon2id}).then(console.log)"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export RAC_PASSWORD_HASH='paste-the-argon2id-hash'
export RAC_SESSION_SECRET='paste-32+-random-base64url-bytes'
export RAC_CONFIG="$HOME/remote-agent-console.json"
pnpm build
pnpm start
```

To run the console and its managed tmux/Codex sessions in Docker instead, see
[the Docker Compose guide](docker.md).

## Worktree commands

Each worktree can define its own trusted shell command. The console changes to
the worktree's canonical path before running it, so commands can use relative
paths and project-local tooling:

```json
{
  "id": "my-project",
  "path": "/absolute/path/to/project",
  "command": "/usr/local/bin/codex"
}
```

The legacy `launch` template remains supported for existing configurations. A
worktree must define either `command` or `launch` (or inherit the top-level
`launch`); it cannot define both.

The default server listener is `127.0.0.1:8787`; `/healthz` is loopback-only and reveals only `{ "ok": true }`. Do not put passwords, prompts, session cookies, CSRF tokens, or WebSocket tickets in configuration or logs.

## Browser capabilities

The console can be installed as a browser app. It requests notification access
only to alert you when an agent changes from working to ready. Voice input is
shown only in browsers that implement the Web Speech API; microphone access is
restricted by the console's permissions policy and is never required to use
the prompt field.

If a worktree has a GitHub `origin` remote and the host has GitHub CLI
credentials (or `RAC_GITHUB_TOKEN`), the console can show a link to its open
pull request. The lookup is read-only and its result is cached briefly.

## Operational checks

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. On a disposable Linux host, start Codex in tmux and confirm it appears; start an ordinary shell/HUD pane and confirm it does not. Verify the configured active worktree is not duplicated, prompt Tab/newline/Ctrl+Enter behavior, and explicitly confirm the session-scoped terminal warning before using terminal access.
