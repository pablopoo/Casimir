import { lookup as dnsLookup } from 'node:dns';
import type { ConnectionOptions } from 'node:tls';
import { Agent } from 'undici';
import {
  assertPublicIdentityUrl,
  boundedIdentityBodyResponse,
} from '../../auth/identity-network.ts';
import { identityPolicyForOrigin, validateIdentityAddressSet } from './identity-policy.ts';
import type {
  IdentityPolicy,
  ResolvedIdentityAddress,
} from './identity-policy.ts';

const IDENTITY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type IdentityResolver = (
  hostname: string,
) => Promise<ReadonlyArray<ResolvedIdentityAddress>>;

export type IdentityTransportOptions = Readonly<{
  /** Resolver injection is for deterministic unit tests; production uses the operating-system resolver. */
  resolve?: IdentityResolver;
}>;

export type IdentityTransport = Readonly<{
  fetch(url: string, options?: RequestInit): Promise<Response>;
  validateUrl(input: string): URL;
  close(): Promise<void>;
}>;

type ConnectorLookup = NonNullable<ConnectionOptions['lookup']>;
type PinnedRequestInit = RequestInit & { dispatcher: Agent };

function systemResolve(hostname: string): Promise<ReadonlyArray<ResolvedIdentityAddress>> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 })));
    });
  });
}

function safeLookupError(): NodeJS.ErrnoException {
  return Object.assign(new Error('Identity endpoint address resolution failed.'), {
    code: 'EAI_AGAIN',
  });
}

function createValidatedLookup(
  expectedHostname: string,
  origin: string,
  policy: IdentityPolicy | undefined,
  resolve: IdentityResolver,
): ConnectorLookup {
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      callback(safeLookupError(), '', 0);
      return;
    }
    void resolve(hostname)
      .then((records) => validateIdentityAddressSet(origin, records, policy))
      .then((validated) => {
        const requestedFamily = options.family;
        const matching = requestedFamily
          ? validated.filter((entry) => entry.family === requestedFamily)
          : validated;
        if (matching.length === 0) {
          callback(safeLookupError(), '', 0);
          return;
        }
        if (options.all) {
          callback(
            null,
            matching.map(({ address, family }) => ({ address, family })),
          );
          return;
        }
        callback(null, matching[0]!.address, matching[0]!.family);
      })
      .catch(() => callback(safeLookupError(), '', 0));
  };
}

function combineSignals(signal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(IDENTITY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Creates a Node-only identity transport with per-origin, DNS-pinned Undici Agents. */
export function createIdentityTransport(
  policy?: IdentityPolicy,
  options: IdentityTransportOptions = {},
): IdentityTransport {
  const resolve = options.resolve ?? systemResolve;
  const agents = new Map<string, Agent>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const validateUrl = (input: string): URL => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error('Identity endpoint URL is invalid.');
    }
    const trusted = identityPolicyForOrigin(url.origin, policy);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.port ||
      url.hostname.endsWith('.') ||
      url.hostname.includes(':') ||
      url.hostname.includes('*') ||
      !url.hostname.includes('.') ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost')
    ) {
      throw new Error('Identity endpoints must use a credential-free HTTPS origin.');
    }
    if (!trusted) {
      // Retain the original Void URL rule for every unlisted provider origin.
      return assertPublicIdentityUrl(input);
    }
    return url;
  };

  const agentFor = (url: URL): Agent => {
    const cached = agents.get(url.origin);
    if (cached) return cached;
    const trusted = identityPolicyForOrigin(url.origin, policy);
    const connect: NonNullable<Agent.Options['connect']> = {
      lookup: createValidatedLookup(url.hostname, url.origin, policy, resolve),
      rejectUnauthorized: true,
      servername: url.hostname,
      ...(trusted?.caPem ? { ca: trusted.caPem } : {}),
      timeout: 5_000,
    };
    const agent = new Agent({
      connect,
      connections: 2,
      pipelining: 1,
      maxResponseSize: MAX_RESPONSE_BYTES,
      keepAliveTimeout: 1_000,
      keepAliveMaxTimeout: 5_000,
    });
    agents.set(url.origin, agent);
    return agent;
  };

  return {
    validateUrl,
    async fetch(input, init = {}) {
      if (closed) throw new Error('identity_transport_closed');
      const url = validateUrl(input);
      const requestOptions: PinnedRequestInit = {
        ...init,
        redirect: 'manual',
        signal: combineSignals(init.signal),
        dispatcher: agentFor(url),
      };
      const response = await fetch(url, requestOptions);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw new Error('Identity endpoint redirects are not allowed.');
      }
      return boundedIdentityBodyResponse(response);
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = Promise.allSettled(
          [...agents.values()].map((agent) => agent.close()),
        ).then((results) => {
          if (results.some((result) => result.status === 'rejected')) {
            throw new Error('identity_transport_close_failed');
          }
        });
      }
      return closePromise;
    },
  };
}
