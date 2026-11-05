import { tags } from 'virtual:tags';
import { defineHandler } from 'void';

export type Props = Readonly<{
  tag: string;
}>;

export const prerender = true;

export function getPrerenderPaths() {
  return tags.map((tag: string) => ({ tag }));
}

export const loader = defineHandler<Props>((c) => {
  return { tag: c.req.param('tag') };
});
