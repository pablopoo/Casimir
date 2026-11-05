/** Shared between the SDK, edge admission and Pages clients. */
export type UsageLimitData = {
  code: 'usage_limit';
  resource: 'ai' | 'sandbox' | 'requests' | 'execution';
  reason: 'monthly_quota' | 'rate_limit' | 'concurrency' | 'runtime_budget' | 'cpu';
  message: string;
  retryAt?: string;
};

export function readUsageLimit(value: unknown): UsageLimitData | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    v.code !== 'usage_limit' ||
    typeof v.message !== 'string' ||
    !['ai', 'sandbox', 'requests', 'execution'].includes(String(v.resource)) ||
    !['monthly_quota', 'rate_limit', 'concurrency', 'runtime_budget', 'cpu'].includes(
      String(v.reason),
    )
  ) {
    return null;
  }
  return {
    code: 'usage_limit',
    resource: v.resource as UsageLimitData['resource'],
    reason: v.reason as UsageLimitData['reason'],
    message: v.message,
    ...(typeof v.retryAt === 'string' && Number.isFinite(Date.parse(v.retryAt))
      ? { retryAt: v.retryAt }
      : {}),
  };
}

export function usageLimitResponse(limit: UsageLimitData): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (limit.retryAt && Number.isFinite(Date.parse(limit.retryAt))) {
    headers.set(
      'Retry-After',
      String(Math.max(0, Math.ceil((Date.parse(limit.retryAt) - Date.now()) / 1000))),
    );
  }
  return Response.json(limit, { status: 429, headers });
}
