import assert from 'node:assert/strict';
const response = await fetch('http://api:4281/projects/none', {
  headers: { Authorization: 'Bearer ' + process.env.CASIMIR_TOKEN },
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 503);
const text = await response.text();
assert.ok(!text.includes(process.env.CASIMIR_TOKEN));
assert.ok(!text.includes(new URL(process.env.DATABASE_URL).password));
console.log('Database outage returns503 without success or credentials');
