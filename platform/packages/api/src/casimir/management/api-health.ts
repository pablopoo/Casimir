import { performance } from 'node:perf_hooks';
import type { HealthCheck } from '../../operator/system-health-contract.ts';

const API_HEALTH_TIMEOUT_MS = 2000;

function isReadyBody(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).ready === true
  );
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

/** Measures this Node process's own HTTP readiness endpoint over loopback. */
export async function probeLocalApiHealth(
  port: number,
  request: typeof fetch = fetch,
): Promise<HealthCheck> {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(API_HEALTH_TIMEOUT_MS);
  const result = (ok: boolean, error?: string): HealthCheck => ({
    name: 'api',
    ok,
    latencyMs: performance.now() - startedAt,
    ...(error ? { error } : {}),
  });
  let response: Response | undefined;

  try {
    response = await request(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      redirect: 'manual',
      signal,
    });
    if (response.status !== 200) {
      return result(false, `Health endpoint returned HTTP ${response.status}.`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (isTimeout(error, signal)) {
        return result(false, 'Local API health check timed out after 2 seconds.');
      }
      return result(false, 'Health endpoint returned invalid readiness data.');
    }
    if (!isReadyBody(body)) {
      return result(false, 'Health endpoint did not report ready.');
    }
    return result(true);
  } catch (error) {
    if (isTimeout(error, signal)) {
      return result(false, 'Local API health check timed out after 2 seconds.');
    }
    return result(false, 'Could not reach the local API health endpoint.');
  } finally {
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => {});
    }
  }
}
