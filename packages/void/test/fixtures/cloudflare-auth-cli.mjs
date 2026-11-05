// File-backed stand-in for Void's bundled Cloudflare CLI. Identities are synthetic.
import { readFileSync, writeFileSync } from 'node:fs';

const filename = 'auth-fixture.json';
const state = JSON.parse(readFileSync(filename, 'utf8'));
const operation = JSON.parse(process.argv[2]);
state.commands.push(operation);
state.credentialStores ??= [];
state.credentialStores.push(process.env.CLOUDFLARE_AUTH_USE_KEYRING ?? 'default');
const finish = (value, status = 0) => {
  writeFileSync(filename, JSON.stringify(state));
  if (value !== undefined) {
    process.stdout.write(JSON.stringify({ operationResult: 1, data: value }));
  }
  process.exit(status);
};

if (operation.type === 'auth.whoami') {
  if (state.badWhoami) {
    finish('invalid whoami output');
  }
  if (
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CF_API_TOKEN ||
    ((process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY) &&
      (process.env.CLOUDFLARE_EMAIL || process.env.CF_EMAIL))
  ) {
    finish({ ...state.session, authType: 'User API Token' });
  }
  finish(state.session ?? { loggedIn: false }, state.session ? 0 : 1);
}
if (operation.type === 'auth.login') {
  if (state.failLogin) {
    finish(undefined, 1);
  }
  state.session = state.nextLogin;
  finish(undefined);
}
if (operation.type === 'auth.logout') {
  delete state.session;
  finish(undefined);
}
finish(undefined, 2);
