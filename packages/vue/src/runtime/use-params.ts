import { inject } from 'vue';

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const params = inject<T>('__void_params');
  if (!params) {
    throw new Error('useParams(): must be used inside a Void page.');
  }
  return params;
}
