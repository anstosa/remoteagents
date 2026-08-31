---
status: accepted
date: 2026-08-28
---

# Adapters describe their agent; the console acts

The console is growing from one agent CLI (Codex, with OMX on top) to several, each behind an *Adapter* (`CONTEXT.md`). An Adapter could drive its agent itself — `adapter.submit(pane, prompt)`, `adapter.state(pane)` — or it could hand the console data and pure functions and let the console's single tmux and `/proc` layer do every side effect. We chose the second: `recognizes(comm, argv)`, `inferState(pane)`, `submission.prepare(prompt)`, `turns.latestCompleted(capture)`, and `launch(input) → args` are pure functions over strings, and only conversation lookup, turn-completion reads, and structured question files touch the filesystem, under injectable roots. We chose this because the Codex logic was already a set of pure string functions in disguise (`isAgentCommand`, `agentAttentionState`, `latestCompletedAssistantTurn`, `queueReadyPrompt`) spread across seven modules; gathering them behind one descriptive interface leaves every effectful path — paste and keys, the srt wrap, pane options, the durable queue — implemented once.

## Considered options

- **Effectful adapters.** Each adapter talks to tmux and `/proc` itself. More power per adapter, but N copies of the pane plumbing, N places to get bracketed paste or the socket path wrong, and every adapter test has to mock tmux.
- **Data-only adapters.** Pure JSON descriptors: a process regex, a title regex, a submit key. Too weak — completed-turn capture and inline-question parsing are real code, and Pi's interrupt key and Claude's `--settings` injection are not expressible as data.
- **Runtime plugins.** Adapters discovered and loaded at start-up. Rejected: the registry is a closed union in code so TypeScript can check exhaustiveness, and the console has no plugin trust story.

## Consequences

- **A new adapter is one directory of pure functions plus one fixture directory.** A shared contract suite (`apps/server/test/adapters/`) runs every adapter against `apps/server/test/fixtures/<kind>/` — process identities, titles, prompts, raw `capture-pane -e -p` snapshots — so an adapter cannot ship without evidence of what it recognises and parses.
- **Capabilities are derived, not declared.** Optional feature objects (`turns`, `completion`, `questions`, `commands`, `conversations`, `panes`) are present or absent; the console computes the capability record the web sees from that. An adapter cannot claim what it does not implement.
- **The `/proc` layer is best-effort, not guaranteed.** Resolving a pane's Codex rollout means reading the file descriptors its process tree holds open, but that `readlink` is not always permitted: a confined console — or a pane launched under a user-namespace/non-dumpable wrapper — yields `EACCES`, so the fd-walk finds nothing. `completion` therefore falls back to matching the pane's tmux `#{pane_current_path}` against the rollout's recorded `cwd`, taken only when that directory is unique among live panes, and otherwise degrades to the `turns` TUI parse rather than guess. Conversation lookup shares the same walk and is subject to the same limit.
- **The console owns launch composition.** An adapter returns only the arguments (and environment) for its CLI; the console prepends the configured program path, hands the adapter the paths of the files it rendered and the Sandboxed flag, and records `@rac_sandboxed` on the pane. The console never wraps a command in `srt` — each adapter realises its sandbox through its own flags (ADR 0004). Adapters never see a program path, a tmux socket, or a pane id.
- **Every adapter is recognised; only configured adapters launch.** Recognition needs no configuration, so a hand-started agent of any known kind appears on the dashboard; the Launch controls list only the kinds whose program is configured.
- **Attention state resolves in one place**: reported (`@rac_attention`, ADR 0001) → an inline question is pending → the adapter's title inference → `finished`. An adapter whose title carries no signal returns `undefined` and says so through `stateSource`, rather than pretending.
- **Agents with an event API do not fit directly.** OpenCode exposes SSE and HTTP endpoints; under this interface the console would have to observe them from outside and translate into the same pane options and pure inputs. That is an accepted limitation until an event-driven agent is actually built.
