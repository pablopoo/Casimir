ARG RUNNER_BASE=casimir-mvp-a-runner:local
FROM ${RUNNER_BASE}
USER root
COPY --chown=node:node casimir/mvp-a/runner/bootstrap.mjs /runner/bootstrap.mjs
COPY --chown=node:node casimir/mvp-a/runner/dist /runner/dist
ARG RUNTIME_ID
LABEL org.casimir.runtime-id=$RUNTIME_ID org.casimir.task="mvp-a" org.casimir.distribution="c1"
USER 1000:1000
