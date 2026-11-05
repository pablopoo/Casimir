import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  parsePlatformAuthenticationSetup,
  PLATFORM_AUTH_SETUP_PROOF_PREFIX,
} from '@void/platform';

/** Normalize the API origin used by installer requests and platform registry entries. */
export function normalizePlatformApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`platform: Invalid platform URL ${JSON.stringify(value)}.`);
  }
  const localHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('platform: Platform URLs must use HTTPS and must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('platform: Platform URLs must not contain query parameters or fragments.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('platform: Platform URLs must not contain a path.');
  }
  return url.origin;
}

/** Submit the original signed authentication setup request without Cloudflare dependencies. */
export async function initializePlatformAuthentication(
  apiUrl: string,
  installationId: string,
  setupToken: string,
  setupJson: string,
  fetcher: typeof fetch = fetch,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  const origin = normalizePlatformApiUrl(apiUrl);
  const setup = parsePlatformAuthenticationSetup(JSON.parse(setupJson));
  const body = JSON.stringify(setup);
  const signature = createHmac('sha256', setupToken)
    .update(`${PLATFORM_AUTH_SETUP_PROOF_PREFIX}\n${installationId}\n${body}`)
    .digest('base64url');
  const response = await fetcher(`${origin}/internal/platform/auth-initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Auth-Setup': signature,
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `platform: Authentication setup failed (HTTP ${response.status}). Its outcome may be unknown; preserve the encrypted setup checkpoint and resume installation.`,
    );
  }
  const result = (await response.json()) as { setupPending?: unknown; expiresAt?: unknown };
  if (
    typeof result.setupPending !== 'boolean' ||
    (result.setupPending &&
      (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))))
  ) {
    throw new Error('platform: The platform returned an invalid authentication setup response.');
  }
  return {
    setupPending: result.setupPending,
    expiresAt: typeof result.expiresAt === 'string' ? result.expiresAt : null,
  };
}

export type PlatformAuthenticationResumeInput = Readonly<{
  apiUrl: string;
  installationId: string;
  setupToken: string;
  setupJson: string;
  checkpoint: (replacement: {
    authenticationSetupJson: string;
    authBootstrapCode: string;
  }) => void | Promise<void>;
}>;

/** Resume the original setup flow and persist an expired-code replacement before resubmission. */
export async function resumePlatformAuthentication(
  input: PlatformAuthenticationResumeInput,
  initialize: typeof initializePlatformAuthentication = initializePlatformAuthentication,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  const result = await initialize(
    input.apiUrl,
    input.installationId,
    input.setupToken,
    input.setupJson,
  );
  if (!result.setupPending || !result.expiresAt || Date.parse(result.expiresAt) > Date.now()) {
    return result;
  }
  const authBootstrapCode = randomBytes(32).toString('hex');
  const authenticationSetupJson = JSON.stringify({
    ...parsePlatformAuthenticationSetup(JSON.parse(input.setupJson)),
    resetPending: true,
    bootstrapCredentialHash: createHash('sha256').update(authBootstrapCode).digest('hex'),
  });
  await input.checkpoint({ authenticationSetupJson, authBootstrapCode });
  return initialize(input.apiUrl, input.installationId, input.setupToken, authenticationSetupJson);
}
