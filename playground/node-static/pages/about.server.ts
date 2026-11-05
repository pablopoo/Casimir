import { defineHandler } from 'void';

export type Props = Readonly<{
  description: string;
}>;

export const loader = defineHandler<Props>(() => {
  return { description: 'A statically prerendered page from Node.js.' };
});
