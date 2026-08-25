# Run with Docker Compose

The default Compose deployment runs only Remote Agent Console. It includes
Node, Codex, zsh, and tmux, and it can launch scratch agents in container-local
tmux without access to the host process tree, host worktrees, or a tunnel.
Host tmux integration and Cloudflare are independent opt-in layers.

## Start the scratch-only console

1. Create the ignored environment and Docker configuration files:

   ```bash
   cp .env.example .env
   cp config/remote-agent-console.example.json config/remote-agent-console.docker.json
   ```

2. Generate and set `RAC_PASSWORD_HASH` and `RAC_SESSION_SECRET` in `.env`.
   Wrap the Argon2 value in single quotes because its `$` characters otherwise
   trigger Compose interpolation.

3. Validate the configuration before building:

   ```bash
   pnpm config:check --compose config/remote-agent-console.docker.json
   ```

4. Build and start the console:

   ```bash
   docker compose up -d --build
   docker compose ps
   curl http://127.0.0.1:8787/healthz
   ```

Open `http://127.0.0.1:8787`. The starter configuration intentionally has no
worktrees. Use **New Agent** to launch a scratch agent inside the container.
Loopback HTTP is local-only; configure canonical HTTPS before remote access.

## Add container-managed worktrees

The repository checkout is already mounted at `/workspace`. Add it or other
bind-mounted projects to `config/remote-agent-console.docker.json`:

```json
{
  "id": "remoteagents",
  "path": "/workspace",
  "command": "codex",
  "resumeCommand": "codex resume {threadId} -C ."
}
```

For additional projects, copy `compose.override.example.yaml` to the ignored
`compose.override.yaml`, remove the host-tmux settings if they are not needed,
and add each project bind under `/worktrees`. The configuration `path` must
match the container bind destination.

## Connect to the host tmux server

Copy `compose.override.example.yaml` to `compose.override.yaml` when the console
must discover and control Codex sessions already running on the host. The
override adds the host process tree, tmux socket, tmux client, Codex home, and
worktree mounts. For every host-backed worktree:

- Set `path` to its container path.
- Set `hostPath` to the corresponding absolute host path.
- Add a matching bind mount to `compose.override.yaml`.
- For linked Git worktrees, mount the common Git directory at the same absolute
  path referenced by the worktree's `.git` file.
- Keep research-only worktrees read-only.

The host bridge is controlled by environment variables rather than image
assumptions:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST_TMUX_BIN` | Host tmux executable or wrapper mounted into the container | `/usr/bin/tmux` |
| `HOST_TMUX_DIR` | Host tmux socket directory | `$HOME/.local/state/tmux/tmux-$HOST_UID` |
| `HOST_UID` | UID owning the host tmux server | `1000` |
| `RAC_HOST_INTERACTIVE_SHELL` | Absolute zsh or bash path executed by the host tmux server | `/usr/bin/zsh` |
| `RAC_HOST_PATH` | Complete PATH exported before host agent and stack commands | `/usr/local/bin:/usr/bin:/bin` |
| `RAC_INTERACTIVE_SHELL` | Absolute zsh or bash path for container-managed sessions | `/usr/bin/zsh` |

The mounted tmux client must run inside the container and speak the same
protocol as the host server. On hosts whose tmux binary needs incompatible
runtime libraries, point `HOST_TMUX_BIN` at an installation-local wrapper and
add its binary and library mounts to the ignored override. The tracked image no
longer assumes Homebrew, an x86-64 loader, or a particular host library layout.

Mount the complete host `${HOME}/.codex` directory, not only `auth.json`. Codex
replaces credentials atomically during refreshes and account changes; a
single-file bind can remain attached to a stale inode.

## Add the optional Cloudflare Tunnel

1. Change `publicOrigin` in the Docker configuration to the canonical HTTPS
   origin, such as `https://agents.example.com`.
2. Copy `config/cloudflared.example.yml` to the ignored
   `config/cloudflared.yml` and configure the tunnel UUID and hostname.
3. Set `CLOUDFLARED_CREDENTIALS_FILE` in `.env` to the absolute credential JSON
   path.
4. Start the tunnel profile:

   ```bash
   docker compose --profile tunnel up -d --build
   docker compose --profile tunnel ps
   ```

Both services use host networking. The application remains bound to loopback,
and `cloudflared` provides the public ingress. Keep
`RAC_PROJECT_PROXY_HOST=127.0.0.1` on Linux host networking unless the container
runtime provides project ports through another stable name.

## Account configuration

Use **Global settings → Add account** after startup. The named `codex-home`
volume preserves container-local account files between rebuilds. Host-tmux
deployments should use the complete host Codex-home bind from the override so
host and console launches select the same account.

## Operations

```bash
docker compose logs -f remote-agent-console
docker compose --profile tunnel logs -f cloudflared
docker compose restart remote-agent-console
docker compose stop                 # prevents automatic restart
docker compose down                 # retains the Codex login volume
docker compose down -v              # also removes the Codex login volume
```

Set `CODEX_VERSION` in the shell or `.env` before building to use a different
Codex package version. The image default is defined in `compose.yaml`.

## Remote deployment

Keep `.env`, `compose.override.yaml`, `config/cloudflared.yml`, tunnel
credentials, and `config/remote-agent-console.docker.json` local to each host.
Deploy by updating and building inside the target checkout:

```bash
ssh target-host \
  'cd /path/to/remoteagents && git pull --ff-only && docker compose up -d --build && docker compose ps'
```

Add `--profile tunnel` to both Compose commands when that host uses the tunnel.
Do not synchronize a source tree, Docker image, generated web assets, or local
configuration between hosts. Each host pulls the same revision and builds with
its own ignored configuration.
