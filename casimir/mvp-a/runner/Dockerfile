FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS native
LABEL org.casimir.task="mvp-a"
WORKDIR /runner
RUN npm install --global pnpm@12.11.2 --ignore-scripts
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3
COPY bootstrap.mjs ./
COPY job.mjs ./
COPY dist ./dist
RUN node bootstrap.mjs smoke

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
LABEL org.casimir.task="mvp-a" org.casimir.profile="node-sqlite-v1"
WORKDIR /app
COPY --from=native --chown=node:node /runner /runner
RUN ln -s /runner/node_modules /app/node_modules && mkdir /data && chown node:node /data
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["node","/runner/bootstrap.mjs"]
