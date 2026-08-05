# README screenshots

These screenshots are generated from the current browser application with
synthetic agents, paths, prompts, Git state, and terminal output. No live
worktree or operator data is included.

Regenerate all images from the repository root:

```bash
pnpm --filter @rac/web screenshots:readme
```

The capture script starts a temporary Vite server on `127.0.0.1:4174`, mocks
the API and WebSocket boundaries in Playwright, writes the PNG files in this
directory, and shuts the server down when complete.
