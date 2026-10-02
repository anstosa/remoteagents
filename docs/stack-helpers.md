# Writing a stack helper

A **stack helper** is a command-line program that a Project's `commands` call
to prepare and run its dev stack, the way `ods` does for the Obsidian
repositories. The console knows nothing about the stack itself; it runs the
helper's commands in tmux, watches the panes, and reads a few files the helper
may write. This page is that contract: what the console gives a command, and
what it expects back. [`setup.md`](setup.md#projects) covers the same
configuration from the operator's side, including what the stack menu shows.

The contract is not versioned. A change to it updates this page.

## Choosing a shape

A Project's stack is one of two shapes, and config validation refuses a mix:

- **Stack processes** (`commands.processes`): each service runs in the
  foreground until it is killed, and the console is its supervisor. Start,
  Stop, Restart and the running state all come from the tmux window the
  console runs it in. Use this unless the stack already has a supervisor.
- **Daemon-style commands** (`start`, `stop`, `restart`, `status`): one-shot
  commands that hand the stack to something else, such as
  `docker compose up -d` or a systemd unit, and a `status` command the console
  polls.

Either shape can also have `setup`, `build` and `migrate`, which are always
one-shot.

A typical helper takes the service name as an argument, so the config is one
line per service:

```json
"commands": {
  "setup": "mystack setup",
  "processes": {
    "db": "mystack exec db",
    "web": { "command": "mystack exec web", "dependsOn": ["db"] }
  }
}
```

A process name is letters, digits, `_` and `-`, at most 20 per map. The
console never passes the name to the command; put it in the command string, as
above.

## What every command gets

Every command, one-shot or process, is a shell string run as

```sh
/bin/bash -lc '<exports>; ( cd -- <worktree root> && { <command>; } )'
```

in a tmux session on the console's tmux server (the host's, when the console
runs in Docker). That means:

- **A login bash.** `~/.bash_profile` and the like are read, and the command
  may use any shell syntax.
- **The Worktree's root as the working directory.** This is the only
  identification the command is given: no Project id, Worktree id, branch or
  port. A helper that needs those derives them from its checkout, for example
  with `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir` and
  `git branch --show-current`. To run from a subdirectory, `cd` in the
  command: `"cd web && pnpm dev"`.
- **`PATH` from `RAC_HOST_PATH`**, when the console's environment sets it, so
  the helper and the tools it runs (`pnpm`, `node`, version-manager shims) must
  be on that path, or the commands use absolute paths.
- **The rest of the environment from the tmux server**, not from the console,
  so a variable the console was started with does not reach the command.
- **The operator's user**, with the operator's full trust. Commands are never
  shown in the browser, and nothing sandboxes them.

## Stack processes

### Running

The console starts a process as a window of the Worktree's Workspace session,
named for the process. On top of the environment above, it exports
`RAC_PROCESS_NOTICES` (see [Process notices](#process-notices)).

The command must **stay in the foreground** for as long as the service runs.
The console reads the state straight from the pane: a live pane is running, a
dead one is exited, with its exit code (none when a signal ended it). A helper
that daemonizes its service, or exits once it has started one, reads as
exited, and Stop will not reach the service.

So a helper that does its own work first (finding ports, writing config,
checking peers) should end by **`exec`-ing the service**, so the service
becomes the pane's process, receives Ctrl+C itself, and its exit code is the
one the console shows.

`dependsOn` orders starts only. The console starts a dependency's window and
moves straight on to the next; it never waits for the dependency to listen. A
service that needs a dependency ready checks for it itself, as `ods` waits for
a file its bundler writes.

### Stopping

Stop sends **Ctrl+C** to the pane, waits up to about 10 seconds for it to
exit, then closes the window whether or not it did; closing the window hangs
up its terminal, so what still runs in it gets `SIGHUP`. The Ctrl+C is a keystroke on the
pane's terminal, so `SIGINT` goes to the terminal's foreground process group:
a child the helper put in a session or process group of its own (`setsid`,
some process managers) does not get it, and is left to the hang-up.

Restart stops the process the same way but keeps the window, then runs the
command again in the same pane.

A whole-stack Stop stops processes in the reverse of start order. Removing a
Worktree stops every running process first.

### Output

Everything the process writes to its terminal shows in its pane, and the
console also writes it to `rac/processes/<name>.log` in the Worktree's git
directory. The helper does nothing for that log. The file starts empty on each
Start and keeps the raw bytes, terminal controls included. An agent or a
helper finds it from the checkout with

```sh
git rev-parse --git-path rac/processes/<name>.log
```

### Surviving a console restart

A process belongs to tmux, not to the console. It keeps running across a
console restart, and the console finds it again by tags on its window. The
helper needs to do nothing for this.

## Process notices

A process can report short messages about its own run, which the stack menu
shows under that process. A `warning` also marks the stack badge. The typical
use is a peer in another checkout that is not running: the notice offers
**Open** for that Worktree and, when it names a process the Worktree declares,
**Start** for it. Only the operator's click starts it.

### The file

`RAC_PROCESS_NOTICES` holds the absolute path of
`rac/processes/<name>.notices.json` in the Worktree's git directory. The
console removes the file before each Start and after each Stop, so a notice
lasts until its process next starts or stops. The variable is absent when the
console could not set up that directory; the helper then reports nothing.

The helper writes a JSON array:

```json
[
  { "level": "warning", "message": "api is not running", "worktree": "/code/backend", "process": "api" },
  { "level": "info", "message": "using the shared staging database" }
]
```

| Field      | Required | Meaning |
|------------|----------|---------|
| `message`  | yes      | Plain text, 1 to 500 characters. Never rendered as markup. |
| `level`    | no       | `warning` (the default) or `info`. |
| `worktree` | no       | Absolute path of a checkout of any configured Project, the one the notice is about. The console resolves symlinks and matches it to a Worktree; a path it does not know shows the message with no buttons. |
| `process`  | no       | A Stack process the `worktree` checkout declares. Needs `worktree`. The notice hides while that process runs. |

The console reads the file again only when it changes. It ignores the whole
file, and logs why, when it is over 64 KB, is not a regular file (a symlink
included), is not valid JSON, or has a notice that does not match the table.
Only the first 20 notices are read. To avoid a half-written file being read,
write a temporary file beside it and rename it into place.

### Do not pass the variable on

The file belongs to the helper. **Unset `RAC_PROCESS_NOTICES` before
`exec`-ing the service**, so a service that happens to use the same variable,
or a nested helper, cannot overwrite the helper's notices.

### Naming processes in other Worktrees

For **Start** to appear, `process` must be the name the *other* Project's
config gives that service. A helper that keeps its own service registry has
to keep those names in step with the console config. `ods` does this by
generating the `commands` block from its registry (`ods console-config`).

## One-shot commands

`setup`, `build`, `migrate`, and in the daemon-style shape `start`, `stop`
and `restart`, run to completion in a tmux session of their own, with the
environment above and no `RAC_PROCESS_NOTICES`.

- **`setup`** runs once, when the console creates a Worktree, before any
  agent launches. Exit 0 lets the launch go ahead; anything else, or running
  longer than 5 minutes, reports a setup error, skips the agent launch, and
  keeps the output under the console's `.data/stack-logs`. It does not run for
  a checkout made outside the console, so a helper should make `setup` safe to
  rerun and tell operators to run it by hand there.
- **`build`, `migrate`, `start`, `stop`, `restart`** run when the operator, or
  an agent through the MCP `run_stack_action` tool, picks them. One runs per
  Worktree at a time. Their combined output is the stack menu's "Show last
  command output".

## Daemon-style status

With no `processes`, the stack badge comes from `status`: **exit 0 means
running**, anything else means stopped. The console runs it about every 30
seconds while the dashboard is open, and gives it 2 seconds. One that takes
longer is killed and its answer dropped, so `status` should be a quick local
check (a pid file, a port, `docker compose ps`), not a request that can hang.
It must not leave a background child holding its terminal.

## Readiness after a Start

In either shape, a Start reads as Starting until the Project's preview URL
(`port` and `hostname`, or `externalUrl`) answers with any status below 500,
for up to a minute; Stop and Restart stay available meanwhile. A stack of
processes also stops reading Starting once none of them is running. With no
preview configured nothing else ends it early, so a helper that wants Starting
to clear when the stack is ready serves something at the preview URL.

## A minimal helper

```bash
#!/usr/bin/env bash
# mystack: `mystack setup` prepares a fresh checkout; `mystack exec <name>`
# runs one service in the foreground for the console.
set -euo pipefail

backend="$(realpath -m ../backend)"

case "${1:-}" in
  setup)
    pnpm install --frozen-lockfile
    ;;
  exec)
    name="${2:?usage: mystack exec <name>}"
    notices="${RAC_PROCESS_NOTICES:-}"
    unset RAC_PROCESS_NOTICES
    if [[ $name == web ]] && ! curl -fsS -o /dev/null http://127.0.0.1:4000/health; then
      echo "mystack: the backend api is not answering on :4000" >&2
      if [[ -n $notices ]]; then
        printf '[{"level":"warning","message":"the backend api is not running","worktree":"%s","process":"api"}]' "$backend" > "$notices.tmp"
        mv "$notices.tmp" "$notices"
      fi
    fi
    case "$name" in
      db) exec postgres -D .data/postgres -p 5433 ;;
      web) exec pnpm --filter web dev ;;
      *) echo "mystack: no service named $name" >&2; exit 64 ;;
    esac
    ;;
  *)
    echo "usage: mystack setup | mystack exec <name>" >&2
    exit 64
    ;;
esac
```

It runs every service in the foreground through `exec`, keeps the notices
file to itself, writes the file whole, and still starts `web` when the peer is
down, so the service can fail in its own words. The `printf` does not escape
the path for JSON; a real helper builds the notice with a JSON encoder.

Run it by hand before configuring it: from a checkout, `mystack exec web`
should run in the foreground and stop on Ctrl+C, and
`RAC_PROCESS_NOTICES=/tmp/n.json mystack exec web` should leave a valid file
in `/tmp/n.json` while the backend is down.
