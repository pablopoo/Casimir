/**
 * Virtual module — resolved by the @void/md Vite plugin at build time.
 * This stub provides type information for TypeScript and linters.
 */
export {};

export type VoidMdPage = Readonly<{
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  headings: ReadonlyArray<{ depth: number; slug: string; text: string }>;
}>;

declare const pages: ReadonlyArray<VoidMdPage>;
export default pages;
