import { parsePlatformAuthenticationSetup } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import {
  initializePlatformAuthentication,
  normalizePlatformApiUrl,
  resumePlatformAuthentication,
  type PlatformAuthenticationResumeInput,
} from './platform-auth-core.ts';

/** Checkpoint a replacement before submission so an interrupted response is safely replayable. */
export function resumeInstalledPlatformAuthentication(
  input: PlatformAuthenticationResumeInput,
  initialize: typeof initializeInstalledPlatformAuthentication = initializeInstalledPlatformAuthentication,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  return resumePlatformAuthentication(input, initialize);
}

export async function initializeInstalledPlatformAuthentication(
  apiUrl: string,
  installationId: string,
  setupToken: string,
  setupJson: string,
  fetcher: typeof fetch = fetch,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  const origin = normalizePlatformApiUrl(apiUrl);
  const setup = parsePlatformAuthenticationSetup(JSON.parse(setupJson));
  if (setup.protection) {
    ensurePlatformAccessToken(origin, false, true);
  }
  const accessHeaders = cfAccessHeaders(process.env, origin);
  const scopedFetcher: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(accessHeaders)) {
      headers.set(name, value);
    }
    return fetcher(input, { ...init, headers });
  };
  return initializePlatformAuthentication(
    apiUrl,
    installationId,
    setupToken,
    setupJson,
    scopedFetcher,
  );
}
