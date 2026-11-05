import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { inspectControlIngressRequestTarget } from '../../platform/packages/api/src/casimir/lifecycle/ingress-readiness.ts';

const SETUP_PATH = '/internal/platform/auth-initialize';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function denied(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/** Restricts the root operator's socket to the one signed setup POST and its inspected TLS ingress. */
export async function createAuthSetupFetch({ engine, controlOrigin, ca, externalTls, target }) {
  const origin = new URL(controlOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || !ca?.length) {
    throw denied('auth_setup_transport_invalid');
  }
  const ingress = target ?? await inspectControlIngressRequestTarget(
    engine,
    controlOrigin,
    ca,
    externalTls,
  );
  if (
    ingress.host !== origin.host ||
    ingress.servername !== canonicalHostname(origin.hostname) ||
    !Number.isInteger(ingress.port) ||
    ingress.port < 1 ||
    ingress.port > 65535 ||
    !ingress.hostname
  ) {
    throw denied('auth_setup_ingress_invalid');
  }

  return async (input, init = {}) => {
    let url;
    try {
      if (typeof input !== 'string') throw new Error('url_type');
      url = new URL(input);
    } catch {
      throw denied('auth_setup_target_refused');
    }
    if (
      url.origin !== origin.origin ||
      url.pathname !== SETUP_PATH ||
      url.search ||
      url.hash ||
      init.method !== 'POST' ||
      init.redirect !== 'manual' ||
      typeof init.body !== 'string'
    ) {
      throw denied('auth_setup_target_refused');
    }
    const body = Buffer.from(init.body, 'utf8');
    if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) {
      throw denied('auth_setup_request_size');
    }
    let headers;
    try {
      headers = new Headers(init.headers);
    } catch {
      throw denied('auth_setup_headers_invalid');
    }
    const allowedHeaders = new Set(['content-type', 'x-void-auth-setup']);
    for (const [name] of headers) {
      if (!allowedHeaders.has(name.toLowerCase())) throw denied('auth_setup_headers_invalid');
    }
    const signature = headers.get('x-void-auth-setup');
    if (
      headers.get('content-type')?.split(';')[0] !== 'application/json' ||
      !signature ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    ) {
      throw denied('auth_setup_headers_invalid');
    }
    if (init.signal?.aborted) throw denied('auth_setup_request_aborted');

    const requestHostname = ingress.hostname;
    const certificateHostname = canonicalHostname(origin.hostname);
    const requestOptions = {
      hostname: requestHostname,
      port: ingress.port,
      path: SETUP_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Void-Auth-Setup': signature,
        Host: origin.host,
        Connection: 'close',
        'Content-Length': String(body.byteLength),
      },
      ca,
      rejectUnauthorized: true,
      timeout: REQUEST_TIMEOUT_MS,
      ...(isIP(certificateHostname) === 0 ? { servername: certificateHostname } : {}),
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(certificateHostname, certificate),
      signal: init.signal ?? undefined,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => {
        request.destroy(denied('auth_setup_transport_timeout'));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      const request = httpsRequest(requestOptions, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(denied('auth_setup_response_size'));
            request.destroy(denied('auth_setup_response_size'));
            finish(reject, denied('auth_setup_response_size'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', (error) => finish(reject, error));
        response.once('end', () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 599 || status === 101) {
            finish(reject, denied('auth_setup_response_invalid'));
            return;
          }
          const responseBody = Buffer.concat(chunks);
          const contentType = response.headers['content-type'];
          const responseHeaders = contentType ? { 'content-type': contentType } : undefined;
          const noBody = [204, 205, 304].includes(status);
          finish(resolve, new Response(noBody ? null : responseBody, {
            status,
            headers: responseHeaders,
          }));
        });
      });
      request.once('error', (error) => finish(reject, error));
      request.end(body);
    });
  };
}
