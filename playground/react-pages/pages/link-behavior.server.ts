import { defineHandler, defineHead } from 'void';

export type Props = Readonly<{
  title: string;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loader = defineHandler<Props>(async (c) => {
  if (c.req.query('abort-slow')) {
    await sleep(1000);
  }

  return { title: 'Link Behavior' };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.title,
    link: [
      { rel: 'stylesheet', href: '/hash-navigation-test.css' },
      {
        rel: 'preload',
        href: '/hash-navigation-test.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: 'anonymous',
      },
    ],
  };
});
