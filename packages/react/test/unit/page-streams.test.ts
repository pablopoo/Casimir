import { expect, it, vi } from 'vite-plus/test';
import { DEFERRED_SHELL_END_MARKER } from '../../src/runtime/deferred-shell.ts';
import { concatStreams, readDeferredShell } from '../../src/runtime/page-streams.ts';

const encoder = new TextEncoder();

function chunkStream(chunks: ReadonlyArray<string>, onCancel?: (reason: unknown) => void) {
  let next = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (next === chunks.length) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(chunks[next++]));
        }
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
}

it('concatenates streams in order without reading ahead of the consumer', async () => {
  let pulls = 0;
  const first = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls <= 32) {
          controller.enqueue(encoder.encode('a'));
        } else {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const joined = concatStreams([first, chunkStream(['b', 'c'])]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pulls).toBeLessThan(4);
  expect(await new Response(joined).text()).toBe(`${'a'.repeat(32)}bc`);
});

it('cancels the active and unopened streams when the consumer stops', async () => {
  const cancelActive = vi.fn();
  const cancelUnopened = vi.fn();
  const joined = concatStreams([
    chunkStream(
      Array.from({ length: 32 }, () => 'a'),
      cancelActive,
    ),
    chunkStream(['b'], cancelUnopened),
  ]);
  const reader = joined.getReader();

  expect((await reader.read()).value).toEqual(encoder.encode('a'));
  await reader.cancel('stopped');
  expect(cancelActive).toHaveBeenCalledWith('stopped');
  expect(cancelUnopened).toHaveBeenCalledWith('stopped');
});

it('stops the deferred shell at a marker split across UTF-8 chunks', async () => {
  const cancelled = vi.fn();
  const bytes = encoder.encode(`é<div>${DEFERRED_SHELL_END_MARKER}late content`);
  const markerStart = encoder.encode('é<div>').length;
  let next = 0;
  const pieces = [
    bytes.slice(0, 1),
    bytes.slice(1, markerStart + 8),
    bytes.slice(markerStart + 8, markerStart + 20),
    bytes.slice(markerStart + 20),
  ];
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(pieces[next++]);
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );

  expect(await new Response(readDeferredShell(source)).text()).toBe(
    `é<div>${DEFERRED_SHELL_END_MARKER}`,
  );
  expect(cancelled).toHaveBeenCalledWith('Void deferred shell complete');
});

it('preserves the whole render when there is no deferred marker', async () => {
  const html = 'é<div>complete</div>';
  expect(
    await new Response(readDeferredShell(chunkStream(['é<div>', 'complete</div>']))).text(),
  ).toBe(html);
});

it('does not drain a deferred render while the consumer is paused', async () => {
  let pulls = 0;
  const cancelled = vi.fn();
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(
          encoder.encode(pulls <= 32 ? '<div>content</div>' : DEFERRED_SHELL_END_MARKER),
        );
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  const shell = readDeferredShell(source);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pulls).toBeLessThan(4);
  await shell.cancel('client disconnected');
  expect(cancelled).toHaveBeenCalledWith('client disconnected');
});
