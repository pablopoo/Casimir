import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';
import { DEPLOYMENT_EXECUTION_LEASE_MS } from '../../src/deployment-execution.ts';

it('lets staging smoke tests observe deployment recovery and retain diagnostics', () => {
  const workflow = readFileSync(
    new URL('../../../../../.github/workflows/platform-smoke-test.yml', import.meta.url),
    'utf8',
  );
  const jobMinutes = Number(workflow.match(/ {4}timeout-minutes: (\d+)/)?.[1]);
  const deployStep =
    workflow.split('- name: Deploy kitchen-sink')[1]?.split('- run: vp exec playwright')[0] ?? '';
  const deployMinutes = Number(deployStep.match(/timeout-minutes: (\d+)/)?.[1]);
  // Recovery cannot claim a live invocation. Allow its lease, the two-minute
  // outbox tick, and five minutes to reconcile before the deploy step expires.
  expect(deployMinutes * 60_000).toBeGreaterThanOrEqual(DEPLOYMENT_EXECUTION_LEASE_MS + 7 * 60_000);
  expect(jobMinutes).toBeGreaterThanOrEqual(deployMinutes + 5);
  expect(workflow).toMatch(
    /if: \$\{\{ always\(\) \}\}[\s\S]*uses: actions\/upload-artifact@[a-f0-9]{40}/,
  );
  expect(workflow).toContain('~/.void/logs/deploy-*.jsonl');
});
