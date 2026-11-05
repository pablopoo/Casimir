import { describe, expect, it } from 'vite-plus/test';
import { isRecord } from '../../src/index.ts';

describe('isRecord', () => {
  it.each([null, undefined, [], [1], 'text', 1, true, Symbol('key'), () => {}])(
    'rejects non-record input %s',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );

  it.each([{}, { key: 'value' }, Object.create(null), new Error('provider failure')])(
    'accepts object input %s',
    (value) => {
      expect(isRecord(value)).toBe(true);
    },
  );
});
