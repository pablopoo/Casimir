#!/usr/bin/env bash
set -euo pipefail
task_container=${CASIMIR_TOOL_CONTAINER:-casimir-mvp-a-tooling}
if [[ $(docker inspect --format '{{index .Config.Labels "org.casimir.task"}}' "$task_container") != mvp-a ]]; then
  echo 'Refusing to use a container not owned by Casimir increment A.' >&2
  exit 1
fi
case ${1:-sdk} in
  sdk)
    docker exec -e PLAYWRIGHT_BROWSERS_PATH=/opt/playwright "$task_container" sh -ec '
      pnpm exec vp run --filter "./packages/**" --parallel build
      pnpm --dir packages/deploy-core run typecheck
      pnpm --dir packages/void run typecheck
      pnpm exec vp test run packages/deploy-core/test/unit/casimir.test.ts packages/void/test/unit/casimir-artifact.test.ts packages/void/test/unit/casimir-sdk.test.ts packages/void/test/unit/plugin-drizzle.test.ts packages/void/test/unit/config.test.ts packages/void/test/unit/env-client-guard.test.ts packages/void/test/integration/casimir-installed.test.ts packages/void/test/integration/node-target.test.ts
    '
    ;;
  admission)
    bash casimir/mvp-a/prepare.sh
    docker exec "$task_container" sh -ec '
      node casimir/build.mjs
      set -a; . .local/mvp-a/api.env; set +a
      node --test --test-timeout=60000 platform/packages/api/test/casimir-node/mvp-admission.test.mjs
    '
    ;;
  cli)
    bash casimir/mvp-a/prepare-runtime.sh
    docker exec -e PLAYWRIGHT_BROWSERS_PATH=/opt/playwright "$task_container" sh -ec '
      pnpm exec vp run --filter "./packages/**" --parallel build
      set -a; . .local/mvp-a/api.env; set +a
      node casimir/mvp-a/check-cli.mjs first
      node casimir/mvp-a/check-cli.mjs retry
      node casimir/mvp-a/check-browser.mjs
    '
    ;;
  flow)
    docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-flow.mjs'
    ;;
  recovery)
    bash casimir/mvp-a/check-recovery.sh
    bash casimir/mvp-a/check-job-crash.sh
    bash casimir/mvp-a/check-boundaries.sh
    ;;
  legacy)
    docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-legacy.mjs'
    ;;
  snapshot)
    docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-recovery.mjs snapshot'
    ;;
  capacity)
    docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-capacity.mjs; node casimir/mvp-a/check-capacity.mjs reject'
    ;;
  foreign)
    bash casimir/mvp-a/check-foreign.sh
    ;;
  all)
    for phase in sdk admission cli flow recovery legacy capacity; do bash casimir/mvp-a/verify.sh "$phase"; done
    ;;
  *) echo 'Available phases: sdk, admission, cli, flow, recovery, legacy, snapshot, capacity, all.' >&2; exit 2 ;;
esac
