import type { Build } from './types.ts';

/**
 * A build occupies a concurrency slot from `starting` until it stops.
 * Queued builds have not yet been assigned a slot.
 */
export const ACTIVE_BUILD_STATUSES: Array<Build['status']> = ['starting', 'building', 'deploying'];

/** Build statuses that will never change again. */
export const TERMINAL_STATUSES: ReadonlyArray<Build['status']> = [
  'complete',
  'failed',
  'cancelled',
];

export function isTerminalBuildStatus(status: Build['status']): boolean {
  return TERMINAL_STATUSES.includes(status);
}
