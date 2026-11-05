import { defineHandler } from 'void';

export type Props = Readonly<{
  title: string;
  runtime: string;
}>;

export const loader = defineHandler<Props>(() => {
  return { title: 'Home', runtime: process.versions.node };
});
