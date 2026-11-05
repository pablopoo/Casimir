import type { ElementType, ReactElement } from 'react';
import { jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime';
import { Fragment, prepare, type JSX } from './jsx-runtime.ts';

export { Fragment };
export type { JSX };

export function jsxDEV(
  type: unknown,
  props: Record<string, unknown>,
  key?: string,
  isStaticChildren?: boolean,
  source?: { fileName: string; lineNumber: number; columnNumber: number },
  self?: unknown,
): ReactElement {
  const prepared = prepare(type, props);
  return reactJsxDEV(
    prepared.type as ElementType,
    prepared.props,
    key,
    isStaticChildren ?? false,
    source,
    self,
  );
}
