FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tooling
LABEL org.casimir.task="control-m1"
WORKDIR /src
RUN npm install --global pnpm@12.11.2 --ignore-scripts
COPY --chown=node:node . .
RUN chown node:node /src
USER node
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM tooling AS runtime
RUN node casimir/build.mjs
USER node
CMD ["node", "casimir/dist/main.mjs"]

FROM tooling AS validation
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git procps ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN pnpm exec playwright install --with-deps chromium
USER node
