import { describe, expect, it } from 'vite-plus/test';
import { generateComponentManifest } from '../../src/pages/manifest.ts';
import type { PageDefinition } from '../../src/pages/types.ts';

function matchRouteFor(pattern: string): (url: string) => string | null {
  const page: PageDefinition = {
    pattern,
    params: ['slug'],
    catchAll: true,
    componentPath: 'docs/[...slug].tsx',
    serverPath: null,
    methods: [],
    componentId: 'docs/[...slug]',
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
  };
  const source = generateComponentManifest(
    { pages: [page], layouts: [], namedLayouts: [] },
    '/project/pages',
  );
  return new Function('URL', `${source}\nreturn matchRoute;`)(URL) as (
    url: string,
  ) => string | null;
}

describe('generated Pages client route manifest', () => {
  it('matches named catch-all pages across path segments', () => {
    const matchRoute = matchRouteFor('/docs/:slug{.+}');

    expect(matchRoute('/docs/a/b')).toBe('docs/[...slug]');
    expect(matchRoute('/docs/a')).toBe('docs/[...slug]');
    expect(matchRoute('/docs')).toBeNull();
  });
});
