import type { SubcommandDef } from './subcommand-prompt.ts';

export const accountSubcommands: Array<SubcommandDef> = [
  { name: 'login', description: 'Log in with an enabled platform login method' },
  { name: 'link', description: 'Link another login method to your account' },
  { name: 'logout', description: 'Log out and remove credentials' },
  { name: 'whoami', description: 'Show the logged-in username' },
  { name: 'token', description: 'Copy auth token to clipboard' },
];

export type AccountArgs =
  | { subcommand: 'login' | 'logout' | 'whoami' | 'token' }
  | { subcommand: 'link'; connectionId?: string };

export function parseAccountArgs(args: Array<string>): AccountArgs {
  const [subcommand, extra, trailing] = args;
  if (subcommand === 'link') {
    if (trailing || (extra !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(extra))) {
      throw new Error('account: Usage: void account link [connection-id].');
    }
    return { subcommand, ...(extra ? { connectionId: extra } : {}) };
  }
  if (!subcommand || !['login', 'logout', 'whoami', 'token'].includes(subcommand)) {
    throw new Error('account: Usage: void account <login|link|logout|whoami|token>.');
  }
  if (extra) {
    throw new Error(`account: Unexpected argument '${extra}'.`);
  }
  return { subcommand: subcommand as AccountArgs['subcommand'] };
}
