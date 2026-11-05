import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ExecutionProfile, ImageAlias } from './types.ts';

export const aliases: ImageAlias[] = ['demo-v1', 'demo-v2', 'demo-broken'];
// This recipe is operator code, never a client supplied execution specification.
export const recipe = Object.freeze({
  version: 1,
  apiVersion: 'v1.47',
  uid: '1000:1000',
  appMemory: 256 * 1024 * 1024,
  appNanoCpus: 500_000_000,
  appPids: 64,
  network: 'casimir-execution-poc_app',
  volume: 'casimir-execution-poc_appdata',
  routes: 'casimir-execution-poc_routes',
  appPort: 3000,
  readonlyRoot: true,
  noNewPrivileges: true,
  journalMode: 'DELETE',
});
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.slice().sort().join(',')
  );
}
export function loadProfile(path: string): ExecutionProfile {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !exact(value, ['recipeVersion', 'scope', 'controlPort', 'appPort', 'images']) ||
      value.recipeVersion !== 1 ||
      value.scope !== 'casimir-execution-poc' ||
      value.controlPort !== 4283 ||
      value.appPort !== 4284 ||
      !exact(value.images, aliases)
    )
      throw new Error();
    const images = {} as ExecutionProfile['images'];
    for (const alias of aliases) {
      const id = value.images[alias];
      if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error();
      images[alias] = id as ExecutionProfile['images'][ImageAlias];
    }
    const canonical = {
      recipeVersion: 1 as const,
      scope: 'casimir-execution-poc' as const,
      controlPort: 4283 as const,
      appPort: 4284 as const,
      images,
    };
    return { ...canonical, fingerprint: digest(JSON.stringify({ profile: canonical, recipe })) };
  } catch {
    throw new Error('execution profile invalid');
  }
}
