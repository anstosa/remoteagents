# Agent notes

## Local-stack deployment

Before giving a final summary for any change that affects the local stack, deploy
that change with `docker compose up -d --build`. Then verify the relevant
services with `docker compose ps` (and any targeted health checks). Do not claim
completion if deployment fails; report the failure and its impact instead.
