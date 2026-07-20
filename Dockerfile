ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /build

RUN apt-get update \
    && apt-get install --no-install-recommends -y g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN corepack enable && pnpm install --frozen-lockfile

COPY apps ./apps
RUN pnpm build && pnpm --filter @rac/server deploy --legacy --prod /opt/rac-server

FROM node:${NODE_VERSION}
ARG CODEX_VERSION=0.144.5
ENV HOME=/home/node \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git tmux \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && printf '%s\n' '#!/bin/sh' 'exec /host-lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --library-path /host-lib/x86_64-linux-gnu:/home/linuxbrew/.linuxbrew/lib:/home/linuxbrew/.linuxbrew/opt/utf8proc/lib:/home/linuxbrew/.linuxbrew/opt/ncurses/lib:/home/linuxbrew/.linuxbrew/opt/libevent/lib /home/linuxbrew/.linuxbrew/bin/tmux "$@"' > /usr/local/bin/host-tmux \
    && chmod 755 /usr/local/bin/host-tmux \
    && mkdir -p /config /workspace /home/node/.codex /home/node/.config/gh \
    && chown -R node:node /config /workspace /home/node \
    && rm -rf /var/lib/apt/lists/* /root/.npm

WORKDIR /app
COPY --from=build /opt/rac-server ./server
COPY --from=build /build/apps/web/dist ./web/dist
COPY --from=build /build/node_modules /opt/rac-dev/node_modules
COPY --from=build /build/apps/server/node_modules /opt/rac-dev/apps/server/node_modules

USER node
EXPOSE 8787
CMD ["node", "server/dist/index.js"]
