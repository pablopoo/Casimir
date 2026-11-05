import { execSync } from 'node:child_process';
import { log } from '@voidzero-dev/vite-plus-prompts';
import type { AccountArgs } from './account-args.ts';
import { getToken, removeToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { runLoginCommand } from './login.ts';
import { printSuccess } from './output.ts';

export async function runAccountCommand(root: string, args: AccountArgs): Promise<void> {
  switch (args.subcommand) {
    case 'login':
      return runLoginCommand(root);
    case 'link':
      return import('./auth-link.ts').then(({ runAuthLink }) =>
        runAuthLink(root, args.connectionId),
      );
    case 'logout':
      if (removeToken(root)) {
        printSuccess('Logged out.');
      } else {
        log.info('Not logged in.');
      }
      return;
    case 'whoami': {
      const token = getToken(root);
      if (!token) {
        log.error('Not logged in. Run `void account login` first.');
        process.exit(1);
      }
      const client = new PlatformClient(token, { root });
      const user = await client.whoami();
      log.info(`${user.login} (${user.plan})`);
      return;
    }
    case 'token': {
      if (!getToken(root)) {
        await runLoginCommand(root);
      }
      const token = getToken(root);
      if (!token) {
        log.error('Login failed. Run `void account login` to try again.');
        process.exit(1);
      }
      const platform = process.platform;
      const cmd =
        platform === 'darwin'
          ? 'pbcopy'
          : platform === 'win32'
            ? 'clip'
            : 'xclip -selection clipboard';
      try {
        execSync(cmd, { input: token });
        printSuccess('Token copied to clipboard.');
      } catch {
        log.warn('Could not copy to clipboard. Run `void account token` again.');
      }
      return;
    }
  }
}
