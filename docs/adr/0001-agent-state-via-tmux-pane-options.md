---
status: accepted
date: 2026-08-28
---

# Agents report their state through tmux pane options

The console polls tmux and derives each Agent's Attention state from its pane title, which works for Codex's spinner prefix but not for Claude Code (its title is the same busy or idle) or Pi (its title never changes). Agents that expose lifecycle hooks now announce their own state — *Reported state* in `CONTEXT.md` — by writing two pane options on their own pane: `@rac_attention` (`working` | `finished` | `question`) and `@rac_session` (the agent's current session id). The console reads them in the `list-panes -F` poll it already runs, next to `@rac_display_label`, which it sets the same way. We chose this because the console's model is "tmux is the source of truth": the channel needs no address, credential, or network, the state survives console restarts, and the reporting hook is one local process spawn.

## Considered options

- **HTTP POST to the console** (Claude's `type: "http"` hooks). Instant and payload-rich, but every hook config would need the console's address plus a token, the state would live only in console memory (every hooked agent reads as finished after a restart until its next event), and a sandboxed agent would need the console host allow-listed. Kept in reserve as an *additional* channel if the console later renders permission prompts or questions inline, where the payload matters.
- **OSC terminal title** (what Codex does natively; Claude's `terminalSequence`, Pi's `ctx.ui.setTitle`). Passes through any sandbox because it is only bytes on the pty, but it races with the agent's own title writes and overloads the label the operator sees.
- **State file** read on each poll. Same polling cost as pane options with a directory convention and cleanup to invent.

## Consequences

- **One channel for every Adapter.** Claude writes it from hooks, Pi from a console-shipped extension (which also reports `question` from Pi's `project_trust` event while the trust selector is open — the one prompt an extension sees before the session starts), and for an agent that only exposes an event stream (OpenCode) the console itself writes the options from outside. The console also writes them itself when it originates an action the agent's hooks cannot see — an interrupt sent from the console resets the agent to `finished`, because Claude's `Stop` hook does not fire on interrupts.
- **Precedence and validity.** Reported state wins over the pane-derived *Inferred state* whenever present, so agents without hooks keep working as before. A report is trusted only while the agent process that made it is alive: the console unsets `@rac_*` when the pane's agent process disappears (crash, pane reused for a shell, a hookless agent started in a pane that still carries an old report). `SessionEnd` clears nothing, because Claude fires it on `/clear` and `/resume` too. No timestamps or TTLs.
- **Hooks are injected per launch, not installed.** The Claude adapter passes `--settings <console-owned file>` on every launch and resume; hook entries merge across settings levels, so the file adds handlers and changes nothing else in the operator's settings. The same script (`scripts/hooks/rac-attention`) is documented as an optional dotfile hook for sessions the console did not start; it exits 0 unless `TMUX_PANE` is set and a tmux binary resolves, so shared dotfiles stay harmless on hosts without the console.
- **The wire carries the console's vocabulary.** Hooks write Attention words, not agent event names; the event-to-state mapping lives in each adapter's injected config, and the reader is agent-agnostic.
- **Sandboxed agents must run their reporter outside the sandbox.** A process that can reach the console's tmux socket can `tmux run-shell` on the host as the operator, so `network.allowAllUnixSockets: true` (which disables srt's seccomp layer for the model's commands too) is a sandbox escape, not an option. Under srt the choices are wrapping only the agent's tool executions rather than the agent process, or a file the console reads and relays into the pane options. Claude's native sandbox is unaffected: it isolates Bash subprocesses only (with the AF_UNIX block active on this host), and hooks run outside it.
