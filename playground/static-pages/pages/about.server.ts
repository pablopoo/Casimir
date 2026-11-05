import { defineHandler } from 'void';

export type Props = Readonly<{
  content: string;
}>;

export const loader = defineHandler<Props>(() => {
  return { content: 'About page content' };
});
