import type { InferenceConfig } from './config.ts';
import type { InferredBindings } from './inference/walk.ts';

/** Apply explicitly named overrides while preserving unrelated source features. */
export function applyBindingOverrides(
  inferred: InferredBindings,
  overrides?: InferenceConfig['bindings'],
): InferredBindings {
  const bindings = { ...inferred };
  if (overrides) {
    const keys = {
      db: 'needsD1',
      kv: 'needsKV',
      storage: 'needsR2',
      ai: 'needsAI',
      email: 'needsEmail',
    } as const;
    for (const [key, inferredKey] of Object.entries(keys)) {
      const value = overrides[key as keyof typeof keys];
      if (value !== undefined) {
        bindings[inferredKey] = Boolean(value);
      }
    }
  }
  return bindings;
}

/** Shared database requirement for development and both deployment targets. */
export function needsApplicationDatabase(
  bindings: Pick<InferredBindings, 'needsD1' | 'needsAuth'>,
  migrationCount: number,
): boolean {
  return bindings.needsD1 || bindings.needsAuth || migrationCount > 0;
}
