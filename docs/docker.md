# Run with Docker Compose

Compose runs the console and a `cloudflared` sidecar. The sidecar maintains the
outbound Cloudflare Tunnel and reconnects after the laptop changes networks.
Both services use host networking so they can share the loopback-only origin
without coupling the tunnel connector to the application container lifecycle.
The console reads the host tmux socket directory and process table to discover
the host user's existing Codex sessions; it does not discover sessions owned by
another UID.
It also uses the host's tmux client, ensuring the client protocol matches the
host tmux server. On Ubuntu hosts this requires a read-only mount of the host
runtime libraries because the Homebrew tmux binary may require a newer glibc
than the container image.
The source checkout is mounted at `/workspace`, so the default worktree changes
to this repository and runs its configured `codex` command.

The supplied Docker configuration keeps host worktrees out of the tracked base
Compose file. Copy `compose.override.example.yaml` to the ignored
`compose.override.yaml`, then add the configured host worktrees under
`/worktrees`. When adding a worktree, add both a `worktrees` entry in the ignored
`config/remote-agent-console.docker.json` and a matching bind mount in the local
override. Set `path` to the container path used to launch an agent and
`hostPath` to the matching host path so existing tmux panes are associated with
that worktree instead of appearing as a duplicate idle card.
For linked Git worktrees, also expose the absolute common Git directory path
referenced by each worktree's `.git` file at the same container path through a
read-only bind. Keep each content mount writable only when the console must stage
prompt attachments there. Before making shared Git metadata read-only, ensure
the repository ignores `node_modules/.remote-agent-console/` or add
`/node_modules/.remote-agent-console/` to the host common Git `info/exclude`.
Mount read-only agent worktrees read-only.

## Start

1. Create `.env` from `.env.example` and supply an Argon2id password hash, a
   session secret, and the absolute path to the Cloudflare Tunnel credential
   JSON. Wrap the Argon2 value in single quotes because its `$` characters
   otherwise trigger Compose variable interpolation. Keep
   `RAC_PROJECT_PROXY_HOST=127.0.0.1` on Linux host networking. Override it only
   when the target container runtime exposes host project ports through another
   stable name, such as `host.docker.internal`.
2. Update `config/remote-agent-console.docker.json`: set `publicOrigin` to the
   canonical HTTPS origin (for example, `https://agents.santosa.dev`) and
   adjust each worktree's `path`, `hostPath`, and `command` or the `/workspace`
   mount if needed. Set an optional `newTask` command to expose **New Task**
   for that worktree; `{taskId}` is replaced with an 8-character URL-safe
   random task ID. The command runs only when the working copy is clean and
   fully pushed. Set the same optional `saveKey` on related worktrees when
   they should share chat bookmarks and sticky notes. Set `HOST_UID` in `.env`
   if the host tmux server is not owned by UID 1000.
3. Copy `config/cloudflared.example.yml` to `config/cloudflared.yml`. Set the
   tunnel UUID and preserve the browser-facing hostname in each `hostname` and
   `httpHostHeader`. Route both project previews and the console to port 8787;
   the console forwards configured project hosts to their fixed loopback ports
   and injects browser navigation reporting. Leave `credentials-file` as
   `/etc/cloudflared/credentials.json`; Compose maps the host credentials file
   there read-only. The sidecar reads these mounts as root, so you can keep both
   host files owner-readable only (for example, modes `600` and `400`
   respectively).
4. Build and start both services:

   ```bash
   docker compose up --build
   ```

   For background operation, use `docker compose up -d --build`. The service is
   configured with `restart: unless-stopped`, so Docker restarts it after a
   daemon or process restart unless it was explicitly stopped.

5. Configure ChatGPT accounts from **Global settings → Add account**. Open the
   displayed ChatGPT device-login link, enter its one-time code, then select the
   new account in the same menu. Repeat this for each account. The named
   `codex-home` volume preserves the private login files between rebuilds.
   Adding an account does not select it. If an account query fails, use its
   **Re-login** action to replace only that account's credentials without
   changing the active selection.

   Opening Global settings refreshes the usage windows and available reset
   count for every configured account. Selecting another account atomically
   changes the Codex login, then restarts open idle worktrees so their resumed
   sessions use it. Working worktrees and worktrees waiting for an answer are
   left untouched.

   Deployments that launch agents through the host tmux server must expose the
   same host Codex home to the container. Put this host-specific bind mount in
   the ignored `compose.override.yaml`:

   ```yaml
   services:
     remote-agent-console:
       volumes:
         - ${HOME}/.codex:/home/node/.codex:rw
   ```

   Mount the complete directory, not only `auth.json`. Codex replaces the
   credential file atomically during refreshes and account changes. A
   single-file bind mount remains attached to the replaced inode, so the
   console can read or update stale credentials instead of the host login.

## Agent shell configuration

The Compose service mounts `${HOME}/.zshenv`, `${HOME}/.zprofile`,
`${HOME}/.zshrc`, and `${HOME}/.bash_aliases` into the container. Console-managed
agents start from interactive Homebrew zsh shells, which load the operator's
normal zsh configuration before running the configured command. Configure
commands with an alias name directly:

```json
{ "id": "main", "path": "/workspace", "command": "codex", "resumeCommand": "codex resume {threadId} -C ." }
{ "id": "research", "path": "/workspace/research", "command": "alex", "resumeCommand": "alex resume {threadId} -C ." }
```

All console-managed Codex launch paths, including worktree launch, scratch
launch, change directory, and new task, therefore use the same zsh functions,
aliases, PATH, and hooks as an operator-opened terminal.

Shell configuration is trusted code and must work inside the container: use
container paths (such as `/workspace`) and ensure their executables are present
in the image. Changes apply to the next worktree launch; no rebuild is needed.

The Compose setup uses Linux host networking so the console's loopback-only
listener remains available at `127.0.0.1:8787` on the Docker host. The bundled
`cloudflared` service is the only public ingress and does not publish a Docker
port. It runs in its own host network namespace, so rebuilding the application
does not require recreating the connector. Both services use
`restart: unless-stopped`, so Docker restores them after a reboot or network
interruption as long as Compose has not been explicitly stopped. A local health
check is available at:

```bash
curl http://127.0.0.1:8787/healthz
```

## Operations

```bash
docker compose logs -f remote-agent-console
docker compose logs -f cloudflared
docker compose restart remote-agent-console
docker compose stop                 # prevents automatic restart
docker compose down                 # removes the container but retains Codex login
docker compose down -v              # also removes the Codex login volume
```

Set `CODEX_VERSION` in the shell or `.env` before building to use a different
Codex package version. The image defaults to `0.144.5`.

## Remote deployment

Keep `.env`, `compose.override.yaml`, `config/cloudflared.yml`, and
`config/remote-agent-console.docker.json` local to each host. Deploy by updating
and building inside the target checkout:

```bash
ssh target-host \
  'cd /path/to/remoteagents && git pull --ff-only && docker compose up -d --build && docker compose ps'
```

Do not synchronize a source tree, Docker image, generated web assets, or local
configuration between hosts. Each host pulls the same repository revision and
builds its own image with its own ignored configuration.
