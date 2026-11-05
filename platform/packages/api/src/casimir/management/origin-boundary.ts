import { getPath } from 'hono/utils/url';

type RequestDispatcher = (request: Request) => Response | Promise<Response>;

const EXACT_MANAGEMENT_PATHS = new Set([
  '/setup',
  '/auth/bootstrap',
  '/auth/bootstrap/confirm',
  '/auth/callback',
  '/internal/platform/auth-initialize',
]);

function isManagementPath(pathname: string): boolean {
  return (
    pathname === '/admin' || pathname.startsWith('/admin/') || EXACT_MANAGEMENT_PATHS.has(pathname)
  );
}

export function isCasimirManagementRequest(request: Request): boolean {
  return isManagementPath(getPath(request));
}

function parseControlOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('control_origin_invalid');
  }

  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.href !== `${origin.origin}/`
  ) {
    throw new Error('control_origin_invalid');
  }

  return origin;
}

function parseAuthority(value: string, protocol: 'http:' | 'https:'): string | null {
  if (!value || value !== value.trim() || /[\s\\/?#,@]/.test(value)) return null;

  try {
    const url = new URL(`${protocol}//${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.host;
  } catch {
    return null;
  }
}

function hasTrustedAuthority(request: Request, requestUrl: URL, trustedAuthority: string): boolean {
  if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') return false;

  const requestAuthority = parseAuthority(requestUrl.host, 'https:');
  if (requestAuthority !== trustedAuthority) return false;

  const hostHeader = request.headers.get('host');
  if (hostHeader === null) return true;

  const publicHost = parseAuthority(hostHeader, 'https:');
  const requestHost = parseAuthority(hostHeader, requestUrl.protocol);
  return publicHost === trustedAuthority && requestHost === requestUrl.host;
}

function misdirectedRequest(): Response {
  return new Response('Misdirected Request', {
    status: 421,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * Reconstruct the configured public HTTPS URL before original management
 * routes inspect `context.req.url`. Forwarded headers are deliberately not an
 * authority source. Non-management requests pass through unchanged.
 */
export function createCasimirManagementRequestHandler(
  controlOrigin: string,
  dispatch: RequestDispatcher,
): RequestDispatcher {
  const trustedOrigin = parseControlOrigin(controlOrigin);

  return async (request) => {
    const requestUrl = new URL(request.url);
    // Match the path Hono's router sees, while retaining the original encoded
    // path when rebuilding the public URL.
    if (!isCasimirManagementRequest(request)) return dispatch(request);
    if (!hasTrustedAuthority(request, requestUrl, trustedOrigin.host)) return misdirectedRequest();

    const canonicalUrl = `${trustedOrigin.origin}${requestUrl.pathname}${requestUrl.search}`;
    const canonicalRequest =
      request.url === canonicalUrl ? request : new Request(canonicalUrl, request);
    return dispatch(canonicalRequest);
  };
}
