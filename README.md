# Remote Agent Console

A self-hosted, single-operator console for discovering Codex/OMX sessions in
tmux, reading their live pane output, sending prompts, and launching configured
worktree agents from one authenticated browser UI.

## Console features

- Live, read-only pane output with reconnect status and scroll controls.
- Prompt delivery, cancellation, and guided Codex/OMX question responses.
- One-click worktree or home-directory agent launches, plus safe removal of
  unmanaged sessions.
- Optional GitHub pull-request links for the active branch and project links
  for configured worktrees.
- Installable browser app support, notification prompts, and voice input when
  the browser provides those capabilities.

## Security model

This console can send input to terminals running as the host user. Keep it on
loopback and expose it only through an HTTPS reverse proxy or authenticated
tunnel that preserves the configured Host and Origin. It is not a multi-user
terminal service.

## Run locally

Requirements: Linux, Node 22+, pnpm, tmux, and an existing Codex executable.

```bash
pnpm install
cp config/remote-agent-console.example.json ~/remote-agent-console.json
cp .env.example .env
# Set RAC_PASSWORD_HASH, RAC_SESSION_SECRET, and RAC_CONFIG in .env.
pnpm build
pnpm start
```

The server listens on `127.0.0.1:8787` by default. Full configuration,
security, and operational guidance is in [docs/setup.md](docs/setup.md).

## Docker Compose

The supplied Compose stack runs the console with a Cloudflare Tunnel sidecar
and mounts the host tmux socket/process information required to discover host
sessions:

```bash
docker compose up -d --build
```

See [docs/docker.md](docs/docker.md) for the required tunnel, credentials, and
worktree configuration.

## Using the console

After authenticating, choose an active agent or an inactive worktree tab.
Inactive worktrees expose **Launch agent**; the **+** tab launches an agent in
the configured home directory. The prompt panel accepts Enter to queue a
prompt, Shift/Ctrl/⌘+Enter for a newline, and Tab to insert a tab character.
Use the terminal button only when direct terminal interaction is necessary.

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
