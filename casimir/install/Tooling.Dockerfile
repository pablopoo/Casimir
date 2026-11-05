# Build this preparation layer with network access, then use it as BUILD_BASE
# for the source-built offline distribution. It prepares only the reference
# consumer's exact dependency graph, not arbitrary future package additions.
ARG PREPARATION_BASE=casimir-c1-control:prepared-source
FROM ${PREPARATION_BASE}
COPY --chown=node:node casimir/install/consumer-pnpm-lock.yaml /src/casimir/install/consumer-pnpm-lock.yaml
USER node
RUN pnpm exec vp run --no-cache --filter './packages/**' --parallel --concurrency-limit=4 build \
 && node casimir/mvp-a/pack-sdk.mjs /src/casimir/install/sdk
USER root
RUN mkdir /bundle \
 && ln -s /src/casimir/install/sdk /bundle/sdk \
 && cp -r /src/casimir/examples/notes /bundle/reference-app \
 && cp /src/casimir/install/consumer-pnpm-lock.yaml /bundle/reference-app/pnpm-lock.yaml
COPY --chown=node:node casimir/install/consumer-pnpm-lock.yaml /tmp/consumer-pnpm-lock.yaml
COPY --chown=node:node casimir/install/test/client-sdk.mjs /tmp/prepare-consumer.mjs
USER node
RUN CASIMIR_PREPARE_NETWORK=1 node /tmp/prepare-consumer.mjs prepare \
 && cmp /tmp/consumer-pnpm-lock.yaml /tmp/casimir-consumer/pnpm-lock.yaml \
 && rm /tmp/consumer-pnpm-lock.yaml /tmp/prepare-consumer.mjs \
 && rm -rf /tmp/casimir-consumer
LABEL org.casimir.task="c1" org.casimir.role="reference-tooling-preparation"
