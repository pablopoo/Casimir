import { describe, expect, it, vi } from 'vite-plus/test';
import { boundedIdentityBodyResponse } from '../../src/auth/identity-network.ts';
import {
  parseIdentityPolicy,
  validateIdentityAddressSet,
} from '../../src/casimir/management/identity-policy.ts';
import { createIdentityTransport } from '../../src/casimir/management/identity-transport.ts';
import {
  managementOwnerMatches,
  validateCasimirManagementOwner,
} from '../../src/casimir/management/management-files.ts';

const testCa = [
  '-----BEGIN CERTIFICATE-----',
  'TUVUQUJBU0U=',
  '-----END CERTIFICATE-----',
  '',
].join('\n');

function privatePolicy(overrides: Record<string, unknown> = {}) {
  return parseIdentityPolicy({
    origins: [
      {
        origin: 'https://identity.example.com',
        addresses: ['10.24.8.3'],
        caPem: testCa,
      },
    ],
    ...overrides,
  });
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = Reflect.get(current, 'code');
    if (typeof code === 'string') codes.push(code);
    current = Reflect.get(current, 'cause');
  }
  return codes;
}

describe('Casimir identity policy', () => {
  it('preserves an exact private origin, its listed RFC1918 address and optional CA', () => {
    expect(privatePolicy()).toEqual({
      origins: [
        {
          origin: 'https://identity.example.com',
          addresses: ['10.24.8.3'],
          caPem: testCa,
        },
      ],
    });
  });

  it.each([
    { origins: [{ origin: 'https://*.example.com', addresses: ['10.24.8.3'] }] },
    { origins: [{ origin: 'https://10.24.8.3', addresses: ['10.24.8.3'] }] },
    { origins: [{ origin: 'https://identity.example.com:8443', addresses: ['10.24.8.3'] }] },
    { origins: [{ origin: 'http://identity.example.com', addresses: ['10.24.8.3'] }] },
    { origins: [{ origin: 'https://localhost', addresses: ['10.24.8.3'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['127.0.0.1'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['169.254.169.254'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['168.63.129.16'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['fd00:ec2::254'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['100.64.0.1'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['fe80::1'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['ff02::1'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['8.8.8.8'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['::ffff:127.0.0.1'] }] },
    { origins: [{ origin: 'https://identity.example.com', addresses: ['10.24.8.3'], caPem: 'not a certificate' }] },
  ])('rejects unsafe or unsupported trusted entries %j', (value) => {
    expect(() => parseIdentityPolicy(value)).toThrow();
  });

  it('rejects unknown fields, duplicate origins and policy size/count overflow', () => {
    expect(() => parseIdentityPolicy({ origins: [], unused: true })).toThrow();
    expect(() =>
      parseIdentityPolicy({
        origins: [
          { origin: 'https://identity.example.com', addresses: ['10.24.8.3'] },
          { origin: 'https://identity.example.com', addresses: ['10.24.8.3'] },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseIdentityPolicy({
        origins: Array.from({ length: 17 }, (_, index) => ({
          origin: `https://idp-${index}.example.com`,
          addresses: ['10.24.8.3'],
        })),
      }),
    ).toThrow();
    expect(() =>
      parseIdentityPolicy({
        origins: [
          {
            origin: 'https://identity.example.com',
            addresses: Array.from({ length: 9 }, (_, index) => `10.24.8.${index + 1}`),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseIdentityPolicy({
        origins: [
          {
            origin: 'https://identity.example.com',
            addresses: ['10.24.8.3'],
            caPem: `${testCa}${'x'.repeat(16 * 1024)}`,
          },
        ],
      }),
    ).toThrow();
  });

  it('allows private addresses only for the exact origin and exact address set', () => {
    const policy = privatePolicy();
    expect(
      validateIdentityAddressSet(
        'https://identity.example.com',
        [{ address: '10.24.8.3', family: 4 }],
        policy,
      ),
    ).toEqual([{ address: '10.24.8.3', family: 4 }]);
    expect(() =>
      validateIdentityAddressSet(
        'https://other.example.com',
        [{ address: '10.24.8.3', family: 4 }],
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateIdentityAddressSet(
        'https://identity.example.com',
        [{ address: '10.24.8.4', family: 4 }],
        policy,
      ),
    ).toThrow();
  });

  it('accepts public IPv4 and global-unicast IPv6 answers for public identity origins', () => {
    expect(
      validateIdentityAddressSet(
        'https://identity.example.com',
        [
          { address: '8.8.8.8', family: 4 },
          { address: '2606:4700:4700::1111', family: 6 },
        ],
      ),
    ).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('rejects mixed, private, special and mapped-address DNS answers for public origins', () => {
    const publicOrigin = 'https://identity.example.com';
    for (const address of [
      '10.24.8.3',
      '127.0.0.1',
      '169.254.169.254',
      '100.100.100.200',
      '::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.24.8.3',
      '::ffff:169.254.169.254',
    ]) {
      const family = address.includes(':') ? 6 : 4;
      expect(() =>
        validateIdentityAddressSet(
          publicOrigin,
          [{ address, family }],
          undefined,
        ),
      ).toThrow();
    }
    expect(() =>
      validateIdentityAddressSet(
        publicOrigin,
        [
          { address: '8.8.8.8', family: 4 },
          { address: '10.24.8.3', family: 4 },
        ],
        undefined,
      ),
    ).toThrow();
  });

  it('normalizes IPv4-mapped IPv6 before matching a private address policy', () => {
    expect(
      validateIdentityAddressSet(
        'https://identity.example.com',
        [{ address: '::ffff:a18:803', family: 6 }],
        privatePolicy(),
      ),
    ).toEqual([{ address: '10.24.8.3', family: 4 }]);
  });
});

describe('Casimir identity transport', () => {
  it('bounds chunked decoded bodies while preserving non-OK response semantics', async () => {
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(128 * 1024));
          controller.enqueue(new Uint8Array(128 * 1024 + 1));
          controller.close();
        },
      }),
      { status: 401 },
    );
    await expect(boundedIdentityBodyResponse(oversized)).rejects.toThrow(
      'The identity provider response is too large.',
    );

    const errorResponse = await boundedIdentityBodyResponse(
      new Response('{"error":"invalid_client"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(errorResponse.status).toBe(401);
    expect(await errorResponse.text()).toBe('{"error":"invalid_client"}');
    expect(errorResponse.headers.get('content-type')).toBe('application/json');
  });

  it('preserves public URL policy while allowing private access only for a configured origin', async () => {
    const defaults = createIdentityTransport();
    expect(defaults.validateUrl('https://identity.example.com/.well-known/openid-configuration').href)
      .toBe('https://identity.example.com/.well-known/openid-configuration');
    expect(() => defaults.validateUrl('http://identity.example.com')).toThrow();
    await defaults.close();

    const trusted = createIdentityTransport(privatePolicy());
    expect(trusted.validateUrl('https://identity.example.com/.well-known/openid-configuration').origin)
      .toBe('https://identity.example.com');
    expect(
      trusted.validateUrl('https://other.example.com/.well-known/openid-configuration').origin,
    ).toBe('https://other.example.com');
    await trusted.close();
  });

  it('closes only its own resolver/dispatcher set and closes idempotently', async () => {
    const firstResolve = vi.fn(async () => {
      throw new Error('first resolver reached');
    });
    const secondResolve = vi.fn(async () => {
      throw new Error('second resolver reached');
    });
    const first = createIdentityTransport(undefined, { resolve: firstResolve });
    const second = createIdentityTransport(undefined, { resolve: secondResolve });
    await first.close();
    await first.close();
    await expect(first.fetch('https://identity.example.com')).rejects.toThrow(
      'identity_transport_closed',
    );
    await expect(second.fetch('https://identity.example.com')).rejects.toThrow();
    expect(firstResolve).not.toHaveBeenCalled();
    expect(secondResolve).toHaveBeenCalledTimes(1);
    await second.close();
  });

  it('rejects a private DNS answer for an unlisted public origin before dialing', async () => {
    const resolve = vi.fn(async () => [{ address: '10.24.8.3', family: 4 as const }]);
    const transport = createIdentityTransport(undefined, { resolve });

    const failure = await transport
      .fetch('https://identity.example.com/.well-known/openid-configuration')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeDefined();
    expect(errorCodes(failure)).toContain('EAI_AGAIN');
    expect(resolve).toHaveBeenCalledWith('identity.example.com');
    expect(resolve).toHaveBeenCalledTimes(1);
    await transport.close();
  });
});

describe('Casimir management identity policy persistence', () => {
  const owner = {
    format: 1 as const,
    installationId: 'a'.repeat(32),
    ownershipNonce: 'b'.repeat(48),
    jwtSecret: 'c'.repeat(64),
    authSetupToken: 'd'.repeat(64),
    projectSecretKeysJson: JSON.stringify({
      '1': Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
    }),
    projectSecretActiveKeyVersion: '1' as const,
    operatorId: 'user_abcdefghijkl',
    projectId: 'proj_abcdefghijkl',
  };

  it('keeps old owner files valid and binds an optional identity policy into owner equality', () => {
    const legacy = validateCasimirManagementOwner(owner);
    expect(legacy).not.toHaveProperty('identityNetwork');
    expect(managementOwnerMatches(legacy, { ...owner })).toBe(true);

    const managed = validateCasimirManagementOwner({
      ...owner,
      identityNetwork: {
        origins: [{ origin: 'https://identity.example.com', addresses: ['10.24.8.3'] }],
      },
    });
    expect(managed.identityNetwork?.origins[0]?.addresses).toEqual(['10.24.8.3']);
    expect(managementOwnerMatches(legacy, managed)).toBe(false);
    expect(() =>
      validateCasimirManagementOwner({
        ...owner,
        identityNetwork: {
          origins: [{ origin: 'https://identity.example.com', addresses: ['127.0.0.1'] }],
        },
      }),
    ).toThrow('management_owner_invalid');
  });
});
