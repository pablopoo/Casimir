import { defineHandler } from 'void';

export type Props = Readonly<{
  slug: string;
}>;

export const prerender = true;

export function getPrerenderPaths() {
  return [{ slug: 'getting-started' }, { slug: 'guides/sidebar-nesting' }];
}

export const loader = defineHandler<Props>((c) => {
  return { slug: c.req.param('slug') ?? '' };
});
