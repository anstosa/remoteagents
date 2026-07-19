# Run with Docker Compose

Compose runs the console and a `cloudflared` sidecar. The sidecar maintains the
outbound Cloudflare Tunnel and reconnects after the laptop changes networks.
The console reads the host tmux socket directory and process table to discover
the host user's existing Codex sessions; it does not discover sessions owned by
another UID.
It also uses the host's tmux client, ensuring the client protocol matches the
host tmux server. On Ubuntu hosts this requires a read-only mount of the host
runtime libraries because the Homebrew tmux binary may require a newer glibc
than the container image.
The source checkout is mounted at `/workspace`, so the default worktree changes
to this repository and runs its configured `codex` command.

The supplied Docker configuration also maps the configured host worktrees under
`/worktrees`. When adding a worktree, add both a `worktrees` entry in
`config/remote-agent-console.docker.json` and a matching bind mount in
`compose.yaml`. Set `path` to the container path used to launch an agent and
`hostPath` to the matching host path so existing tmux panes are associated with
that worktree instead of appearing as a duplicate idle card.

## Start

1. Create `.env` from `.env.example` and supply an Argon2id password hash, a
   session secret, and the absolute path to the Cloudflare Tunnel credential
   JSON. Wrap the Argon2 value in single quotes because its `$` characters
   otherwise trigger Compose variable interpolation.
2. Update `config/remote-agent-console.docker.json`: set `publicOrigin` to the
   canonical HTTPS origin (for example, `https://agents.santosa.family`) and
   adjust each worktree's `path`, `hostPath`, and `command` or the `/workspace`
   mount if needed. Set `HOST_UID` in `.env` if the host tmux server is not
   owned by UID 1000.
3. Copy `config/cloudflared.example.yml` to `config/cloudflared.yml`. Set the
   tunnel UUID and the same hostname in both `hostname` and `httpHostHeader`.
   Leave `credentials-file` as `/etc/cloudflared/credentials.json`; Compose
   maps the host credentials file there read-only. The sidecar reads these
   mounts as root, so you can keep both host files owner-readable only (for
   example, modes `600` and `400` respectively).
4. Build and start both services:

   ```bash
   docker compose up --build
   ```

   For background operation, use `docker compose up -d --build`. The service is
   configured with `restart: unless-stopped`, so Docker restarts it after a
   daemon or process restart unless it was explicitly stopped.

5. Authenticate Codex once (the named `codex-home` volume preserves the login):

   ```bash
   docker compose exec remote-agent-console codex login
   ```

## Worktree aliases

The Compose service mounts `${HOME}/.bash_aliases` into the container and every
custom worktree command sources it before execution. Configure commands with
the alias name directly:

```json
{ "id": "main", "path": "/workspace", "command": "codex" }
{ "id": "research", "path": "/workspace/research", "command": "alex" }
```

Aliases are trusted shell code and must work inside the container: use
container paths (such as `/workspace`) and ensure their executables are present
in the image. Changes apply to the next worktree launch; no rebuild is needed.

The Compose setup uses Linux host networking so the console's loopback-only
listener remains available at `127.0.0.1:8787` on the Docker host. The bundled
`cloudflared` service is the only public ingress and does not publish a Docker
port. Both services use `restart: unless-stopped`, so Docker restores them after
a reboot or network interruption as long as Compose has not been explicitly
stopped. A local health check is available at:

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
