import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import {
  log,
  settings,
  spinner,
  stream,
  taskLog,
  updateSettings,
} from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

const originalSettings = { withGuide: settings.withGuide, accessible: settings.accessible };

function capture(isTTY = false) {
  let text = '';
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    { columns: 52, isTTY },
  );
  return { output, text: () => stripVTControlCharacters(text) };
}

beforeEach(() => updateSettings({ withGuide: false, accessible: false }));
afterEach(() => {
  updateSettings(originalSettings);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('uses one space after log symbols and aligns continuation lines', () => {
  const c = capture();
  log.step('Building', { output: c.output });
  log.info('First line\nSecond line', { output: c.output });
  log.info('Guided\nContinued', { output: c.output, withGuide: true });
  expect(c.text()).toBe('◇ Building\n● First line\n  Second line\n● Guided\n│ Continued\n');
});

it('uses one space in streamed messages', async () => {
  const c = capture();
  const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 52 });
  try {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => c.output.write(chunk));
    await stream.info(['First line\nSecond line']);
    expect(c.text()).toBe('● First line\n  Second line\n');
  } finally {
    if (columns) {
      Object.defineProperty(process.stdout, 'columns', columns);
    } else {
      Reflect.deleteProperty(process.stdout, 'columns');
    }
  }
});

it('uses one space in animated spinner frames', () => {
  vi.stubEnv('CI', '');
  vi.stubEnv('TERM', 'xterm-256color');
  vi.useFakeTimers();
  const c = capture(true);
  const progress = spinner({ output: c.output });
  progress.start('Building');
  vi.advanceTimersByTime(80);
  progress.stop('Built');
  expect(c.text()).toContain('◒ Building');
  expect(c.text()).toContain('◐ Building');
  expect(c.text()).not.toMatch(/[◒◐] {2}/);
});

it('uses one space in task headings and completion messages', () => {
  const c = capture();
  const task = taskLog({ title: 'Build', output: c.output });
  task.message('Building modules');
  task.success('Built');
  expect(c.text()).toContain('◇ Build\n');
  expect(c.text()).toContain('◆ Built\n');
  expect(c.text()).not.toMatch(/[◇◆] {2}/);
});
