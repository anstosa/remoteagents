# systemd deployment

Run the console as the same Unix user that owns the tmux sessions. A user unit
gives the server direct access to that user's tmux socket, Codex accounts, Git
credentials, and worktrees without container bind mounts or host-path aliases.

## Prerequisites

Install Node.js 22 or newer, pnpm, tmux, Codex, and the C/C++ toolchain needed
by `node-pty`. Then install and build the application:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Copy `.env.example` to the ignored `.env`, and copy
`config/remote-agent-console.example.json` to an ignored, host-specific path.
Set `RAC_CONFIG` to that path and use absolute paths for every Project.

The listener defaults to `127.0.0.1:8787` from the config file. To bind a
different address without editing the config, set `RAC_LISTEN_HOST` and/or
`RAC_LISTEN_PORT` in `.env`; for example, to serve a reverse proxy running in
Docker via the bridge gateway:

```bash
RAC_LISTEN_HOST=172.19.0.1
RAC_LISTEN_PORT=8787
```

The host must be a specific IP literal; wildcard binds (`0.0.0.0`, `::`) are
rejected at startup. Prefer loopback or a private interface, never a public one.

The server does not search `PATH` for tmux; it defaults to `/usr/bin/tmux`. If
tmux lives elsewhere (for example under mise or Homebrew), set `RAC_TMUX_BIN`
in `.env` to the absolute path of the real executable, not a version-manager
shim, and make sure it is the same tmux that owns the sessions the console
attaches to. Otherwise API requests fail with `spawn /usr/bin/tmux ENOENT`:

```bash
RAC_TMUX_BIN=/home/user/.local/share/mise/installs/tmux/3.7b/tmux
```

Sessions the console launches run inside an interactive shell so the
operator's normal configuration is loaded before the agent starts. The shell
defaults to `/usr/bin/zsh` and must be an absolute path to zsh or bash; other
shells such as fish are not supported. If zsh is not installed, set
`RAC_INTERACTIVE_SHELL` in `.env` or launches fail silently: the tmux session
exits immediately and the API reports that Codex did not become ready.

```bash
RAC_INTERACTIVE_SHELL=/usr/bin/bash
```

The agent programs come from the config file's `adapters` block (see
[Adapters](setup.md#adapters)); use absolute paths and update them when a CLI is
reinstalled elsewhere. Host-specific lifecycle shims — such as the OMX-on-ZFS
session-pointer cleanup on `adapters.omx` — belong in the adapter entry's
`setup`/`teardown` commands rather than a wrapper script. `RAC_CODEX_BIN` selects the Codex executable the review
tour, ChatGPT account management, and the update advisor spawn; when it is unset
those default to `adapters.codex.program`. With neither set, those Codex-only
features report unavailable rather than spawning a bare `codex`.

Container-only variables (`RAC_HOST_PROC`, `RAC_HOST_TMUX_DIR`,
`RAC_HOST_TMUX_SOURCE`, and `RAC_HOST_UID`) must be omitted. The native server
uses `/proc` and the current user's tmux socket automatically.

The unit hardens the service with `ProtectSystem=strict`, so only the paths in
`ReadWritePaths` are writable. `/tmp` is included because the server hands
launch descriptors to tmux through `/tmp/remote-agent-console-<uid>`, and
`PrivateTmp` stays off so the user's tmux server can read them. If you
customize the unit, keep both settings; otherwise starting an agent fails with
`ENOENT: no such file or directory, mkdir '/tmp/remote-agent-console-<uid>'`.

The one-time `worktrees[]` → Projects migration (see
[setup.md](./setup.md#migrating-from-worktrees)) rewrites the config file and
the `.data` stores in place on first boot, so both must be inside
`ReadWritePaths`. If the config lives outside the repo (a path you point
`RAC_CONFIG` at), either add its directory to `ReadWritePaths` for that one boot
or run `pnpm config:migrate "$RAC_CONFIG"` as your user before starting the
service; the migration refuses to boot rather than start unmigrated.

## Install the user service

The installer renders absolute paths into the untracked user unit, leaving the
checked-in template portable:

```bash
./scripts/install-systemd.sh
```

If Node is managed by a version manager and is not visible to a non-interactive
shell, pass its real executable path:

```bash
NODE_BIN=/absolute/path/to/node ./scripts/install-systemd.sh
```

Enable lingering so the user service starts at boot before the user logs in:

```bash
sudo loginctl enable-linger "$USER"
```

Verify the service and loopback health endpoint:

```bash
systemctl --user status remote-agent-console
curl --fail http://127.0.0.1:8787/healthz
journalctl --user -u remote-agent-console -f
```

Build after pulling application updates, then restart the unit:

```bash
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart remote-agent-console
```

Keep the service on loopback or a private interface. Publish it through an
authenticated HTTPS reverse proxy or a separately installed `cloudflared`
system service.
