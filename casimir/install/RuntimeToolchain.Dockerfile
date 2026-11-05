ARG NODE_BASE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG PREPARATION_BASE=casimir-c1-control:prepared-source

FROM ${NODE_BASE} AS toolchain
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && dpkg-query -W ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Resolve the exact locked runtime modules and offline SDK consumer cache from
# the already-prepared source image. This stage is discarded; its workspace,
# reference SDK, and development dependencies are never copied into runtime.
FROM ${PREPARATION_BASE} AS dependency-prep
USER root
RUN mkdir -p /bundle /src/casimir/install/runtime-deps /opt/casimir-client-store /opt/casimir-runtime-store \
 && chown -R node:node /opt/casimir-client-store /opt/casimir-runtime-store /src/casimir/install/runtime-deps \
 && ln -s /src/casimir/install/sdk /bundle/sdk \
 && cp -r /src/casimir/examples/notes /bundle/reference-app
COPY --chown=node:node casimir/install/runtime-deps/package.json /src/casimir/install/runtime-deps/package.json
COPY --chown=node:node casimir/install/runtime-deps/pnpm-lock.yaml /src/casimir/install/runtime-deps/pnpm-lock.yaml
COPY --chown=node:node casimir/install/test/client-sdk.mjs /tmp/prepare-consumer.mjs
COPY --chown=node:node casimir/install/consumer-pnpm-lock.yaml /bundle/reference-app/pnpm-lock.yaml
COPY --chown=node:node casimir/install/consumer-pnpm-lock.yaml /tmp/consumer-pnpm-lock.yaml
USER node
ENV PNPM_CONFIG_STORE_DIR=/opt/casimir-runtime-store
RUN pnpm_store_path="$(pnpm store path)"; \
    case "$pnpm_store_path" in \
      /opt/casimir-runtime-store/*) ;; \
      *) echo "unexpected_runtime_pnpm_store_path:$pnpm_store_path" >&2; exit 1 ;; \
    esac
RUN cd /src/casimir/install/runtime-deps \
 && pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts \
 && test -n "$(find /opt/casimir-runtime-store -mindepth 1 -print -quit)" \
 && pnpm rebuild better-sqlite3 \
 && node --input-type=module -e "import {createRequire} from 'node:module'; const Database=createRequire(import.meta.url)('./node_modules/better-sqlite3'); const db=new Database(':memory:'); if(db.prepare('select 42 n').get().n!==42)process.exit(1); db.close(); console.log('runtime_native_sqlite_loaded')" \
 && find /opt/casimir-runtime-store -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
RUN pnpm_store_path="$(PNPM_CONFIG_STORE_DIR=/opt/casimir-client-store pnpm store path)"; \
    case "$pnpm_store_path" in \
      /opt/casimir-client-store/*) ;; \
      *) echo "unexpected_client_pnpm_store_path:$pnpm_store_path" >&2; exit 1 ;; \
    esac
RUN CASIMIR_PREPARE_NETWORK=1 PNPM_CONFIG_STORE_DIR=/opt/casimir-client-store node /tmp/prepare-consumer.mjs prepare \
 && test -n "$(find /opt/casimir-client-store -mindepth 1 -print -quit)" \
 && cmp /tmp/casimir-consumer/pnpm-lock.yaml /tmp/consumer-pnpm-lock.yaml \
 && rm /tmp/consumer-pnpm-lock.yaml \
 && rm -rf /tmp/casimir-consumer /tmp/prepare-consumer.mjs

# Keep SDK consumer registry metadata separate from the immutable pnpm store.
# The temporary synthetic consumer is removed in this same layer; only its
# verified cache is copied into the final runtime image.
FROM dependency-prep AS client-metadata
USER root
RUN install -d -o 1000 -g 1000 /home/node/.cache/pnpm-client
COPY --chown=node:node casimir/install/test/client-sdk.mjs /tmp/prepare-client-metadata.mjs
USER node
ENV PNPM_CONFIG_STORE_DIR=/opt/casimir-client-store \
    PNPM_CONFIG_CACHE_DIR=/home/node/.cache/pnpm-client \
    PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy
RUN set -eu; \
    pnpm_store_path="$(pnpm store path)"; \
    case "$pnpm_store_path" in \
      /opt/casimir-client-store/*) ;; \
      *) echo "unexpected_client_pnpm_store_path:$pnpm_store_path" >&2; exit 1 ;; \
    esac; \
    cache_dir="$(pnpm config get cacheDir)"; \
    test "$cache_dir" = "$PNPM_CONFIG_CACHE_DIR"; \
    import_method="$(pnpm config get package-import-method)"; \
    test "$import_method" = copy; \
    test -n "$(find /opt/casimir-client-store -mindepth 1 -print -quit)"; \
    store_hash_before="$(find /opt/casimir-client-store -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"; \
    CASIMIR_PREPARE_NETWORK=1 node /tmp/prepare-client-metadata.mjs prepare; \
    cmp /tmp/casimir-consumer/pnpm-lock.yaml /bundle/reference-app/pnpm-lock.yaml; \
    test -n "$(find "$PNPM_CONFIG_CACHE_DIR" -mindepth 1 -print -quit)"; \
    metadata_bytes="$(du -sb "$PNPM_CONFIG_CACHE_DIR" | cut -f1)"; \
    metadata_files="$(find "$PNPM_CONFIG_CACHE_DIR" -type f | wc -l)"; \
    printf 'client_metadata_cache_bytes=%s files=%s\n' "$metadata_bytes" "$metadata_files"; \
    store_hash_after="$(find /opt/casimir-client-store -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"; \
    test "$store_hash_before" = "$store_hash_after"; \
    printf 'client_store_hash=%s unchanged=yes\n' "$store_hash_after"; \
    rm -rf /tmp/casimir-consumer /tmp/prepare-client-metadata.mjs

# Only the fresh Node base and the selected offline runtime closure survive.
FROM toolchain AS runtime-base
USER root
COPY --from=dependency-prep /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s ../lib/node_modules/pnpm/pnpm /usr/local/bin/pnpm
COPY --from=dependency-prep --chown=1000:1000 /opt/casimir-client-store /opt/casimir-client-store
COPY --from=dependency-prep --chown=1000:1000 /src/casimir/install/runtime-deps/node_modules /src/node_modules
ENV PNPM_CONFIG_STORE_DIR=/opt/casimir-client-store
RUN pnpm_store_path="$(pnpm store path)"; \
    case "$pnpm_store_path" in \
      /opt/casimir-client-store/*) ;; \
      *) echo "unexpected_final_pnpm_store_path:$pnpm_store_path" >&2; exit 1 ;; \
    esac \
 && test -n "$(find /opt/casimir-client-store -mindepth 1 -print -quit)"
COPY --from=client-metadata --chown=1000:1000 /home/node/.cache/pnpm-client /home/node/.cache/pnpm-client
ENV PNPM_CONFIG_CACHE_DIR=/home/node/.cache/pnpm-client \
    PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy
RUN cache_dir="$(pnpm config get cacheDir)" \
 && test "$cache_dir" = "$PNPM_CONFIG_CACHE_DIR" \
 && test "$(pnpm config get package-import-method)" = copy \
 && test -n "$(find "$PNPM_CONFIG_CACHE_DIR" -mindepth 1 -print -quit)"
LABEL org.casimir.task="c1" org.casimir.role="runtime-toolchain" org.casimir.node-base="sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
