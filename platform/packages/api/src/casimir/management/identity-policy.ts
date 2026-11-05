import { BlockList, isIP } from 'node:net';
import { assertPublicIdentityUrl } from '../../auth/identity-network.ts';

const MAX_POLICY_BYTES = 32 * 1024;
const MAX_ORIGINS = 16;
const MAX_ADDRESSES_PER_ORIGIN = 8;
const MAX_CA_BYTES = 16 * 1024;

export type IdentityPolicyOrigin = Readonly<{
  origin: string;
  addresses: ReadonlyArray<string>;
  caPem?: string;
}>;

export type IdentityPolicy = Readonly<{
  origins: ReadonlyArray<IdentityPolicyOrigin>;
}>;

export type ResolvedIdentityAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

const privateAddresses = new BlockList();
privateAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
privateAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
privateAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
privateAddresses.addSubnet('fc00::', 7, 'ipv6');

const nonPublicAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['168.63.129.16', 32],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublicAddresses.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  nonPublicAddresses.addSubnet(address, prefix, 'ipv6');
}
const privateIdentityDeniedAddresses = new BlockList();
privateIdentityDeniedAddresses.addAddress('168.63.129.16', 'ipv4');
privateIdentityDeniedAddresses.addAddress('fd00:ec2::254', 'ipv6');
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseIPv6Words(address: string): Array<number> {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const split = value.lastIndexOf(':');
    const ipv4 = value.slice(split + 1).split('.').map(Number);
    if (split < 0 || ipv4.length !== 4 || ipv4.some((part) => part < 0 || part > 255)) {
      throw new Error('identity_address_invalid');
    }
    const upper = ((ipv4[0]! << 8) | ipv4[1]!).toString(16);
    const lower = ((ipv4[2]! << 8) | ipv4[3]!).toString(16);
    value = `${value.slice(0, split + 1)}${upper}:${lower}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) throw new Error('identity_address_invalid');
  const left = halves[0] ? halves[0]!.split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error('identity_address_invalid');
  }
  const words = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  if (words.length !== 8 || words.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    throw new Error('identity_address_invalid');
  }
  return words;
}

function formatIPv6(words: ReadonlyArray<number>): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < words.length; ) {
    if (words[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) return words.map((part) => part.toString(16)).join(':');
  const left = words.slice(0, bestStart).map((part) => part.toString(16)).join(':');
  const right = words.slice(bestStart + bestLength).map((part) => part.toString(16)).join(':');
  return `${left}::${right}`;
}

/** Normalize IPv4-mapped IPv6 before range checks and socket selection. */
export function normalizeIdentityAddress(address: string): ResolvedIdentityAddress {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error('identity_address_invalid');
  if (family === 4) return { address, family: 4 };
  const words = parseIPv6Words(address);
  if (words.slice(0, 5).every((part) => part === 0) && words[5] === 0xffff) {
    const high = words[6]!;
    const low = words[7]!;
    return {
      address: `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
      family: 4,
    };
  }
  return { address: formatIPv6(words), family: 6 };
}

function isPrivate(address: ResolvedIdentityAddress): boolean {
  return privateAddresses.check(address.address, address.family === 4 ? 'ipv4' : 'ipv6');
}

function isKnownMetadataAddress(address: ResolvedIdentityAddress): boolean {
  return privateIdentityDeniedAddresses.check(
    address.address,
    address.family === 4 ? 'ipv4' : 'ipv6',
  );
}

function isPublic(address: ResolvedIdentityAddress): boolean {
  if (address.family === 4) return !nonPublicAddresses.check(address.address, 'ipv4');
  return (
    globalUnicastV6.check(address.address, 'ipv6') &&
    !nonPublicAddresses.check(address.address, 'ipv6')
  );
}

function parseOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('identity_policy_origin_invalid');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('identity_policy_origin_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value !== url.origin ||
    url.port ||
    url.hostname.endsWith('.') ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.includes('*') ||
    !url.hostname.includes('.') ||
    isIP(url.hostname) !== 0
  ) {
    throw new Error('identity_policy_origin_invalid');
  }
  return url.origin;
}

function parseCa(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') === 0) {
    throw new Error('identity_policy_ca_invalid');
  }
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  const remainder = value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim();
  if (
    !blocks?.length ||
    remainder ||
    value.includes('PRIVATE KEY') ||
    blocks.some((block) => {
      const body = block
        .replace('-----BEGIN CERTIFICATE-----', '')
        .replace('-----END CERTIFICATE-----', '')
        .replace(/\s+/g, '');
      return !body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body);
    })
  ) {
    throw new Error('identity_policy_ca_invalid');
  }
  return value;
}

/** Parse the root-owned private identity policy with strict fields and fixed bounds. */
export function parseIdentityPolicy(value: unknown): IdentityPolicy {
  if (!record(value) || !exactKeys(value, ['origins'])) {
    throw new Error('identity_policy_invalid');
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new Error('identity_policy_invalid');
  }
  if (bytes > MAX_POLICY_BYTES || !Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > MAX_ORIGINS) {
    throw new Error('identity_policy_size');
  }
  let caBytes = 0;
  const seen = new Set<string>();
  const origins = value.origins.map((entry) => {
    if (!record(entry)) throw new Error('identity_policy_origin_invalid');
    const hasCa = Object.hasOwn(entry, 'caPem');
    if (!exactKeys(entry, hasCa ? ['origin', 'addresses', 'caPem'] : ['origin', 'addresses'])) {
      throw new Error('identity_policy_origin_invalid');
    }
    const origin = parseOrigin(entry.origin);
    if (seen.has(origin)) throw new Error('identity_policy_origin_duplicate');
    seen.add(origin);
    if (
      !Array.isArray(entry.addresses) ||
      entry.addresses.length < 1 ||
      entry.addresses.length > MAX_ADDRESSES_PER_ORIGIN
    ) {
      throw new Error('identity_policy_addresses_invalid');
    }
    const addresses = entry.addresses.map((candidate) => {
      if (typeof candidate !== 'string') throw new Error('identity_policy_addresses_invalid');
      const normalized = normalizeIdentityAddress(candidate);
      if (!isPrivate(normalized) || isKnownMetadataAddress(normalized)) {
        throw new Error('identity_policy_address_not_private');
      }
      return normalized.address;
    });
    if (new Set(addresses).size !== addresses.length) {
      throw new Error('identity_policy_address_duplicate');
    }
    if (!hasCa) return { origin, addresses };
    const caPem = parseCa(entry.caPem);
    caBytes += Buffer.byteLength(caPem, 'utf8');
    if (caBytes > MAX_CA_BYTES) throw new Error('identity_policy_ca_size');
    return { origin, addresses, caPem };
  });
  return { origins };
}

/** Validate every DNS answer before handing that same address set to the socket connector. */
export function validateIdentityAddressSet(
  origin: string,
  addresses: ReadonlyArray<ResolvedIdentityAddress>,
  policy?: IdentityPolicy,
): ReadonlyArray<ResolvedIdentityAddress> {
  const trusted = policy?.origins.find((entry) => entry.origin === origin);
  if (!trusted) assertPublicIdentityUrl(origin);
  if (addresses.length < 1 || addresses.length > MAX_ADDRESSES_PER_ORIGIN) {
    throw new Error('identity_dns_answers_invalid');
  }
  const result: Array<ResolvedIdentityAddress> = [];
  const seen = new Set<string>();
  for (const candidate of addresses) {
    if (candidate.family !== 4 && candidate.family !== 6) {
      throw new Error('identity_dns_answer_invalid');
    }
    const normalized = normalizeIdentityAddress(candidate.address);
    if (isIP(candidate.address) !== candidate.family) {
      throw new Error('identity_dns_answer_invalid');
    }
    const key = `${normalized.family}:${normalized.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (trusted) {
      if (
        !isPrivate(normalized) ||
        isKnownMetadataAddress(normalized) ||
        !trusted.addresses.includes(normalized.address)
      ) {
        throw new Error('identity_private_address_not_allowed');
      }
    } else if (!isPublic(normalized)) {
      throw new Error('identity_public_address_required');
    }
    result.push(normalized);
  }
  if (result.length === 0) throw new Error('identity_dns_answers_invalid');
  return result;
}

export function identityPolicyForOrigin(
  origin: string,
  policy?: IdentityPolicy,
): IdentityPolicyOrigin | undefined {
  return policy?.origins.find((entry) => entry.origin === origin);
}
