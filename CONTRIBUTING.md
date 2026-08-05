# Contributing

Remote Agent Console sits on a sensitive boundary: browser actions can become
terminal input and worktree commands. Keep changes focused, preserve the
single-operator security model, and include evidence for behavior changes.

## Local setup

```bash
pnpm install
cp config/remote-agent-console.example.json ~/remote-agent-console.json
cp .env.example .env
```

Follow [docs/setup.md](docs/setup.md) for required secrets and paths. The
browser app can be developed independently with `pnpm --filter @rac/web dev`;
API behavior requires the Linux/tmux environment described in the setup guide.

## Before opening a change

Run the smallest targeted tests while iterating, then the repository checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For visible browser changes, add or update a Playwright spec in `apps/web/e2e`.
If the README presentation changes, regenerate its privacy-safe screenshots:

```bash
pnpm --filter @rac/web screenshots:readme
```

## Change expectations

- Keep diffs small and reuse existing utilities and interaction patterns.
- Add no dependency unless the change cannot reasonably use the current stack.
- Validate an agent target immediately before terminal input or destructive
  operations; never trust a stale pane identity.
- Bound persisted data, in-memory state, request bodies, and WebSocket frames.
- Keep secrets, prompt contents, session cookies, CSRF tokens, and tickets out
  of logs and test fixtures.
- Use synthetic names, paths, prompts, and output in screenshots.
- Update the relevant setup or Docker documentation when configuration changes.

## Pull requests

Explain the user-visible result, important security or lifecycle decisions, and
the commands used for validation. Include screenshots for UI changes when they
clarify responsive layout, interaction state, or accessibility behavior.
