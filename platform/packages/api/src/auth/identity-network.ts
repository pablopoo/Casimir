const MAX_RESPONSE_BYTES = 256 * 1024;

/** Public Internet egress only. Private IdPs need a deliberately published HTTPS endpoint. */
export function assertPublicIdentityUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw new Error('Identity endpoints must use credential-free HTTPS on the standard port.');
  }
  const host = url.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host.endsWith('.') ||
    host.includes(':') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    /^\d+(?:\.\d+){3}$/.test(host)
  ) {
    throw new Error('Identity endpoints must use a public DNS hostname.');
  }
  return url;
}

export async function boundedIdentityResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('The identity provider request failed.');
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('The identity provider response is too large.');
  }
  const bytes = await readBoundedIdentityBody(response);
  return new Response(bytes, { status: response.status, headers: response.headers });
}

/**
 * Bounds the decoded body while retaining non-OK status semantics for callers
 * such as GitHub's token and profile handlers.
 */
export async function boundedIdentityBodyResponse(response: Response): Promise<Response> {
  const bytes = await readBoundedIdentityBody(response);
  const headers = new Headers(response.headers);
  // Fetch exposes decoded bodies. Do not retain metadata describing the
  // compressed or otherwise encoded wire representation.
  headers.delete('content-length');
  headers.delete('content-encoding');
  const noBodyStatus = [204, 205, 304].includes(response.status);
  return new Response(noBodyStatus ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readBoundedIdentityBody(
  response: Response,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        length += result.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new Error('The identity provider response is too large.');
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
