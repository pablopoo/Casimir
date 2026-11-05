FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG VERSION
LABEL org.casimir.task=execution-poc
WORKDIR /app
COPY casimir/demo/*.mjs ./
ENV CASIMIR_DEMO_VERSION=$VERSION
USER 1000:1000
CMD ["node","/app/server.mjs"]
