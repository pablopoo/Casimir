import { readFile } from 'node:fs/promises';
import { inspectManagementStatePair } from './management-state.mjs';

try {
  const identity = JSON.parse(await readFile('/state/identity.json', 'utf8'));
  const receipt = JSON.parse(await readFile('/state/receipt.json', 'utf8'));
  await inspectManagementStatePair('/state', identity, receipt, process.argv[2]);
  console.log(JSON.stringify({ validated: true }));
} catch (error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = /^[a-z0-9_]{1,96}$/.test(message) ? message : 'management_state_invalid';
  console.log(JSON.stringify({ validated: false, code }));
}
