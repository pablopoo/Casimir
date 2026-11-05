import { useContext } from 'react';
import { ParamsContext } from './context.ts';

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const params = useContext(ParamsContext);
  if (params === null) {
    throw new Error('useParams(): must be used inside a Void page.');
  }
  return params as T;
}
