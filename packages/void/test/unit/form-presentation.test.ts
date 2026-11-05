import { afterEach, expect, it, vi } from 'vite-plus/test';
import { VoidActionError } from '../../src/pages/action-result.ts';
import {
  formErrorMessage,
  formSubmissionBlocked,
  scheduleFormRetry,
} from '../../src/pages/form-presentation.ts';
const error = () =>
  new VoidActionError({
    status: 429,
    statusText: '',
    url: '/',
    body: {
      code: 'usage_limit',
      resource: 'ai',
      reason: 'rate_limit',
      message: 'Please try later',
      retryAt: new Date(Date.now() + 2000).toISOString(),
    },
  });
afterEach(() => vi.useRealTimers());
it('preserves field errors and uses the server-provided quota message', () => {
  expect(formErrorMessage({ error: null, errors: { name: 'Name is required' } })).toBe(
    'Name is required',
  );
  expect(formErrorMessage({ error: error(), errors: {} })).toBe('Please try later');
});
it('blocks only while pending or until a known retry deadline, without submitting', async () => {
  vi.useFakeTimers();
  const form = { pending: false, error: error() };
  const ready = vi.fn();
  const cancel = scheduleFormRetry(form.error, ready);
  expect(formSubmissionBlocked(form)).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(ready).toHaveBeenCalledOnce();
  expect(formSubmissionBlocked(form)).toBe(false);
  cancel();
  const cancelNext = scheduleFormRetry(error(), ready);
  cancelNext();
  await vi.advanceTimersByTimeAsync(2000);
  expect(ready).toHaveBeenCalledOnce();
});
