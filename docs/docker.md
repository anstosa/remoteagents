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

## Add container-managed Projects

The repository checkout is already mounted at `/workspace`. Declare it, or any
other bind-mounted repository, as a Project in
`config/remote-agent-console.docker.json`; its Worktrees are discovered from git
inside the container:

```json
{
  "projects": [
    { "id": "remoteagents", "label": "Remote Agent Console", "path": "/workspace" }
  ]
}
```

For additional Projects, copy `compose.override.example.yaml` to the ignored
`compose.override.yaml`, remove the host-tmux settings if they are not needed,
and add each repository bind under `/worktrees`. A Project's `path` must match
the container bind destination.

## Connect to the host tmux server

Copy `compose.override.example.yaml` to `compose.override.yaml` when the console
must discover and control Codex sessions already running on the host. The
override adds the host process tree, tmux socket, tmux client, Codex home, and
worktree mounts. For every host-backed Project:

- Set the Project's `path` to its container path.
- Set `hostPath` to the corresponding absolute host path of the Main worktree.
- Add a matching bind mount to `compose.override.yaml`.
- Discovered Linked worktrees must be mounted at the **same absolute path**
  inside the container as on the host, and their common Git directory mounted at
  the path referenced by each worktree's `.git` file.
- Keep research-only checkouts read-only.

Creating and removing Worktrees (the launcher's **New worktree…** control) is
available only for a Project the container mounts at its host path — that is,
when `hostPath` is absent or equal to `path`. When they differ, git inside the
container would write the container's paths into the repository's worktree
metadata, which the host could not follow, so the console disables the Add
control and reports the reason. To manage such a repository's Worktrees, run
`git worktree add` on the host instead; the console discovers the result on its
next tick.

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

Pull-request lookup also needs GitHub credentials inside the container. The
override example mounts the complete host `${HOME}/.config/gh` directory
read-only so GitHub CLI credential updates remain visible. This works when the
host `hosts.yml` contains an `oauth_token`; GitHub CLI credentials held only in
an operating-system credential store are not available inside the container.
In that case, set `RAC_GITHUB_TOKEN` in the ignored `.env` instead. Do not copy
a token into tracked Compose configuration.

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
