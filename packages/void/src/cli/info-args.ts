import { parseArgs } from 'node:util';

export type InfoArgs = { json: boolean };

export function parseInfoArgs(args: Array<string>): InfoArgs {
  const parsed = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (parsed.positionals.length > 0) {
    throw new Error(`info: Unexpected argument '${parsed.positionals[0]}'.`);
  }
  return { json: parsed.values.json ?? false };
}
