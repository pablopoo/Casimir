import { getContext } from 'svelte';

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const ctx = getContext<{ value: T }>('__void_params');
  if (!ctx) {
    throw new Error('useParams(): must be used inside a Void page.');
  }
  return ctx.value;
}
