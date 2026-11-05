import { DEFERRED_SHELL_CANCEL_REASON, DEFERRED_SHELL_END_MARKER } from './deferred-shell.ts';

export function concatStreams(
  streams: ReadonlyArray<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  const cancelRemaining = async (reason: unknown) => {
    const cancellations: Array<Promise<unknown>> = [];
    if (reader) {
      cancellations.push(reader.cancel(reason));
    }
    for (let remaining = index + (reader ? 1 : 0); remaining < streams.length; remaining++) {
      cancellations.push(streams[remaining].cancel(reason));
    }
    await Promise.allSettled(cancellations);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (index < streams.length) {
            reader ??= streams[index].getReader();
            const { done, value } = await reader.read();
            if (cancelled) {
              return;
            }
            if (done) {
              reader.releaseLock();
              reader = undefined;
              index++;
              continue;
            }
            controller.enqueue(value);
            return;
          }
          controller.close();
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
            await cancelRemaining(error);
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        await cancelRemaining(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export function readDeferredShell(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const keepLength = DEFERRED_SHELL_END_MARKER.length - 1;
  let buffer = '';
  let cancelled = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (cancelled) {
              return;
            }
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

            const markerIndex = buffer.indexOf(DEFERRED_SHELL_END_MARKER);
            if (markerIndex !== -1) {
              const shell = buffer.slice(0, markerIndex + DEFERRED_SHELL_END_MARKER.length);
              await reader.cancel(DEFERRED_SHELL_CANCEL_REASON);
              if (!cancelled) {
                controller.enqueue(encoder.encode(shell));
                controller.close();
              }
              return;
            }

            if (done) {
              if (buffer) {
                controller.enqueue(encoder.encode(buffer));
              }
              controller.close();
              return;
            }

            if (buffer.length > keepLength) {
              controller.enqueue(encoder.encode(buffer.slice(0, -keepLength)));
              buffer = buffer.slice(-keepLength);
              return;
            }
          }
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
            await reader.cancel(error).catch(() => {});
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
