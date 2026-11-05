import { defineHandler, defineHead } from 'void';

export type Props = Readonly<{
  title: string;
}>;

export const loader = defineHandler<Props>(() => {
  return { title: 'Home' };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.title,
    meta: [{ name: 'description', content: 'React Pages playground home' }],
  };
});
