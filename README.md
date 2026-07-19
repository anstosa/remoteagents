# Remote Agent Console

A self-hosted, single-operator console for discovering Codex/OMX sessions in
tmux, reading their live pane output, sending prompts, and launching configured
worktree agents from one authenticated browser UI.

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

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
