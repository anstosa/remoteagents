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

The default server listener is `127.0.0.1:8787`; `/healthz` is loopback-only and reveals only `{ "ok": true }`. Do not put passwords, prompts, session cookies, CSRF tokens, or WebSocket tickets in configuration or logs.

## Operational checks

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. On a disposable Linux host, start Codex in tmux and confirm it appears; start an ordinary shell/HUD pane and confirm it does not. Verify the configured active worktree is not duplicated, prompt Tab/newline/Ctrl+Enter behavior, and explicitly confirm the session-scoped terminal warning before using terminal access.
