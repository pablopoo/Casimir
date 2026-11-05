import type { Context } from 'hono';
import { FateRequestError } from '@nkzw/fate/server';
import { OperatorError } from '../../operator/common.ts';
import type { PlatformManagementEnv } from '../../env.ts';

export const ADMIN_PAGE_SIZE = 20;

export async function loadPageRecords<Item>(
  ids: Array<string>,
  loader: (id: string) => Promise<Item>,
): Promise<Array<Item>> {
  try {
    return await Promise.all(ids.map(loader));
  } catch (error) {
    if (error instanceof OperatorError) {
      throw new FateRequestError(error.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', error.message, {
        status: error.status,
      });
    }
    throw error;
  }
}

export function pageLocation(path: string, pathname: string): URL {
  const url = new URL(path, 'https://admin.invalid');
  if (
    !path.startsWith('/admin/') ||
    url.origin !== 'https://admin.invalid' ||
    url.pathname !== pathname
  ) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  return url;
}

export function detailLocation(path: string, prefix: string): { id: string; url: URL } {
  const url = new URL(path, 'https://admin.invalid');
  if (
    !path.startsWith(prefix) ||
    !url.pathname.startsWith(prefix) ||
    url.origin !== 'https://admin.invalid'
  ) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  const encodedId = url.pathname.slice(prefix.length);
  if (!encodedId || encodedId.includes('/')) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  return { id: decodeURIComponent(encodedId), url };
}

export function pageNumber(url: URL) {
  return Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
}

export function requestTimezone<E extends PlatformManagementEnv>(context: Context<E>): string {
  return (context.req.raw as Request & { cf?: { timezone?: string } }).cf?.timezone ?? 'UTC';
}
