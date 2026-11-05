FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tooling
LABEL org.casimir.task="mvp-a"
WORKDIR /src
RUN npm install --global pnpm@12.11.2 --ignore-scripts
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git procps ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node . .
RUN chown node:node /src
USER node
RUN pnpm install --frozen-lockfile --ignore-scripts
# Build only this lock-pinned native dependency, never arbitrary workspace scripts.
RUN node --input-type=module -e "import fs from 'node:fs'; const p='pnpm-workspace.yaml'; fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('better-sqlite3: false','better-sqlite3: true'))" && pnpm rebuild better-sqlite3
RUN cd packages/void && node --input-type=module -e "import Database from 'better-sqlite3'; const d=new Database(':memory:'); if(d.prepare('select 7 n').get().n!==7)process.exit(1); d.close()"
CMD ["sleep", "infinity"]

FROM tooling AS runtime
RUN node casimir/build.mjs
CMD ["node", "casimir/dist/main.mjs"]

FROM tooling AS validation
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN node node_modules/playwright/cli.js install --with-deps chromium
USER node
