# Adapter fixtures

One directory per agent `kind`. The shared contract suite in
`../adapters/contract.test.ts` runs every registered Adapter against its own
fixture directory, so an Adapter cannot ship without evidence of what it
recognises and parses (ADR 0002).

Each `<kind>/` directory holds:

- **`processes.json`** — `{ match, noMatch }` process identities (`comm` + `argv`)
  fed to `recognizes()`. `recognizes` sees a single process; a sandbox wrapper
  (`srt`/`bwrap`) is an ancestor and belongs in `noMatch`.
- **`titles.json`** — `[{ title, state }]` pane titles fed to `inferState()`.
  A kind whose title carries no signal maps every title to `undefined`.
- **`prompts.json`** — `[{ prompt, mode, text, keys }]` fed to
  `submission.prepare()`. The suite also asserts the generic key rules on the
  produced keys (Enter never without a paste; never `Escape Escape`; never
  `C-c C-c`).
- **`captures.json`** *(optional; only for kinds with `turns`)* — raw
  `capture-pane -e -p` snapshots (`lines` joined with `\n`) and the expected
  `latestCompletedTurn` (`null` ⇒ none), `lastPrompt`, `latestMessage`, and
  `failed`.
- **`conversations.json`** *(optional; only for kinds with `conversations`)* —
  `{ valid, invalid }` conversation ids fed to `validId()`.

## Codex

Captured from today's Codex/OMX behaviour: the inline strings already exercised
by `tmux.test.ts`, `prompts.test.ts` and `processes.test.ts`, which are
themselves snapshots of live Codex panes. Because chunk 1 commit 1 lands
fixtures-first, the suite runs green against today's code through the shim in
`../adapters/codex-shim.ts` before any Codex logic moves — so a later chunk that
drifts Codex behaviour fails the contract suite rather than a person.

Codex has no golden `files` (hooks/sandbox settings) to pin; those arrive with
the Claude and Pi kinds. The numbered-choice → Inline question parser still
lives in the web bundle today, so it is not yet exercised here; it moves
server-side (and gains capture fixtures) later in chunk 1.
