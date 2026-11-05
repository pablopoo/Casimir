import { stripVTControlCharacters } from 'node:util';

/** Read only Vite's bound loopback address, never a probed or suggested port. */
export function packedServerUrl(output) {
  const url = stripVTControlCharacters(output).match(
    /Local:\s+(http:\/\/127\.0\.0\.1:[1-9]\d*\/)/,
  )?.[1];
  return url ? new URL(url).origin : undefined;
}
