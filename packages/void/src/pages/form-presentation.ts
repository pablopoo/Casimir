import type { VoidActionError } from './action-result.ts';

export type FormMethod = 'post' | 'put' | 'patch' | 'delete';
export type FormModel<Args extends Array<unknown> = []> = {
  readonly pending: boolean;
  readonly error: VoidActionError | null;
  readonly errors: Readonly<Record<string, string | undefined>>;
} & { [K in FormMethod]: (...args: Args) => void | Promise<void> };

export function formErrorMessage(form: Pick<FormModel, 'error' | 'errors'>): string | null {
  return form.error?.message ?? (Object.values(form.errors).filter(Boolean).join('. ') || null);
}
export function formRetryMessage(error: VoidActionError | null): string | null {
  return error?.limit?.retryAt
    ? `Try again after ${new Date(error.limit.retryAt).toUTCString()}.`
    : null;
}
export function formSubmissionBlocked(
  form: Pick<FormModel, 'pending' | 'error'>,
  now: number = Date.now(),
): boolean {
  return (
    form.pending ||
    (form.error?.limit?.retryAt ? Date.parse(form.error.limit.retryAt) > now : false)
  );
}
/** One deadline, capped for browser timers; no polling and no automatic submission. */
export function scheduleFormRetry(error: VoidActionError | null, ready: () => void): () => void {
  const retryAt = error?.limit?.retryAt;
  if (!retryAt) {
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = Date.parse(retryAt) - Date.now();
    if (remaining <= 0) {
      ready();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };
  schedule();
  return () => clearTimeout(timer);
}
