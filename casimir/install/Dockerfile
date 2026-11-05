# BUILD_BASE supplies the fixed source-build dependencies. RUNTIME_BASE is a
# fresh Node image with only the selected offline runtime and SDK closure.
ARG BUILD_BASE=casimir-c1-prepared:local
ARG RUNTIME_BASE=casimir-c1-node-toolchain:local
FROM ${BUILD_BASE} AS prepared
FROM docker:29.9.1-dind@sha256:3e5756e2b6dad6a5f1f5deacf0a19f9eaa2581b76ae092b2d4a118162e1d4d4e AS dockercli

FROM prepared AS build
USER root
COPY casimir/install/clean-source.mjs /tmp/c1-clean-source.mjs
RUN node /tmp/c1-clean-source.mjs /src && rm -rf /bundle && rm /tmp/c1-clean-source.mjs
COPY --chown=node:node . /src
WORKDIR /src
USER node
RUN pnpm exec vp run --no-cache --filter './packages/**' --parallel --concurrency-limit=4 build \
 && node casimir/build.mjs \
 && node casimir/mvp-a/runtime.mjs \
 && node casimir/mvp-a/pack-sdk.mjs /src/casimir/install/sdk \
 && node casimir/install/stage-release.mjs /src /home/node/c1-release

FROM ${RUNTIME_BASE} AS runtime
USER root
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

# These layers are stable across C1 source and target releases.
COPY --from=build --chown=1000:1000 /home/node/c1-release/casimir/examples/notes /bundle/reference-app
COPY --from=build --chown=1000:1000 /home/node/c1-release/casimir/install/consumer-pnpm-lock.yaml /bundle/reference-app/pnpm-lock.yaml
COPY --from=build --chown=1000:1000 /home/node/c1-release/ /src/

# The packed SDK is generated from this exact source revision and is consumed
# both by the bundle packager and by the bundled offline reference app.
COPY --from=build --chown=1000:1000 /src/casimir/install/sdk/ /src/casimir/install/sdk/
RUN ln -s /src/casimir/install/sdk /bundle/sdk

ENV PNPM_CONFIG_STORE_DIR=/opt/casimir-client-store
RUN cmp /src/casimir/install/consumer-pnpm-lock.yaml /bundle/reference-app/pnpm-lock.yaml
WORKDIR /src
USER node
LABEL org.casimir.task="c1"
CMD ["node", "casimir/install/cli.mjs"]
