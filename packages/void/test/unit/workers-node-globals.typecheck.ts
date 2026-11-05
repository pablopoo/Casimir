import { randomBytes } from 'node:crypto';
import { expectTypeOf } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';

expectTypeOf(Buffer).not.toBeAny();
expectTypeOf(process).not.toBeAny();
expectTypeOf(Buffer.from('void')).toEqualTypeOf<Buffer<ArrayBuffer>>();
expectTypeOf(randomBytes(8).toString('hex')).toEqualTypeOf<string>();

declare const chunk: unknown;
if (Buffer.isBuffer(chunk)) {
  expectTypeOf(chunk.toString('utf8')).toEqualTypeOf<string>();
}
if (chunk instanceof Buffer) {
  expectTypeOf(chunk.toString('utf8')).toEqualTypeOf<string>();
}

// @ts-expect-error Node's constructor does not accept a numeric input.
Buffer.from(123);
