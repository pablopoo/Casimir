import { defineHandler } from 'void';

export type Props = Readonly<{
  slug: string;
}>;

export const prerender = true;

export function getPrerenderPaths() {
  return [{ slug: 'hello' }, { slug: 'world' }];
}

export const loader = defineHandler<Props>((c) => {
  return { slug: c.req.param('slug') };
});
