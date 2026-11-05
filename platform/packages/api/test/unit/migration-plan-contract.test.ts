import { describe, expect, it } from 'vite-plus/test';
import {
  buildMigrationPlanBundle,
  classifyMigration,
} from '../../../../../packages/void/src/migrations/plan.ts';
import {
  classifyServerMigrationPlan,
  validateSubmittedExecutionPlans,
} from '../../src/migrations/execution-plan.ts';

const fixtures = [
  {
    name: '001.sql',
    sql: 'CREATE TABLE a (id TEXT);',
    sqlHash: 'sha256:dc03b29483ad6dee601eccb58670369b2fe3bbd7f1ef779fc45dcd7ab2bba031',
    planHash: 'sha256:c700d9182caaf85d354cf52a66d26b65710eb0f275d2c41b28e35934755a2b94',
  },
  {
    name: '002.sql',
    sql: 'CREATE TABLE a (id TEXT);\n--> statement-breakpoint\nCREATE TABLE b (id TEXT);',
    sqlHash: 'sha256:ebedb6ca86ac623283037a0cff6c63800ffc6716a8529ea989a740b5144070c8',
    planHash: 'sha256:35ab79b562eff57cba048c200815f9717986afa5cf48664b8059c031e88bdcd3',
  },
  {
    name: '003.sql',
    sql: '-- void:allow-unsplit-multi-statement\nCREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);',
    sqlHash: 'sha256:2b8fac3e3208cb082e4125f8bb25a5777bc2016d226fabf2fee804d26e38ddb4',
    planHash: 'sha256:fe9d62021d54d6ecd2daa8e7064cea05356f2eefedda13f61250c08d0cb3a60e',
  },
];

describe('migration plan wire contract', () => {
  it.each(fixtures)('preserves hashes and independent validation for $name', async (fixture) => {
    const { warnings: _warnings, ...plan } = classifyMigration(fixture);
    expect(plan).toMatchObject({ sqlHash: fixture.sqlHash, planHash: fixture.planHash });
    expect(await classifyServerMigrationPlan(fixture)).toEqual(plan);
    expect(await validateSubmittedExecutionPlans([fixture], [plan])).toBeNull();

    const normalized = { ...fixture, sql: `\uFEFF${fixture.sql.replaceAll('\n', '\r\n')}` };
    expect(classifyMigration(normalized).sqlHash).toBe(fixture.sqlHash);
    expect(await classifyServerMigrationPlan(normalized)).toEqual(plan);
  });

  it('preserves protocol and classifier versions and the empty-list digest', () => {
    expect(buildMigrationPlanBundle([])).toEqual({
      protocolVersion: 2,
      classifierVersion: 1,
      destructiveValidation: 'passed',
      plans: [],
      migrationListHash: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    });
  });

  it('keeps CLI execution policy separate from server classification', async () => {
    const transaction = { name: 'tx.sql', sql: 'BEGIN; SELECT 1; COMMIT;' };
    expect(() => classifyMigration(transaction)).toThrow('contains BEGIN');
    expect((await classifyServerMigrationPlan(transaction)).kind).toBe(
      'legacy-unsplit-multi-statement',
    );

    const empty = { name: 'empty.sql', sql: '--> statement-breakpoint' };
    expect(() => classifyMigration(empty)).toThrow('no SQL statements');
    expect(await classifyServerMigrationPlan(empty)).toMatchObject({
      kind: 'breakpoint-framed',
      statements: [],
    });
  });

  it('rejects changed SQL, hashes, kinds, and statements on the server', async () => {
    const fixture = fixtures[1];
    const plan = { ...classifyMigration(fixture) };
    expect(
      await validateSubmittedExecutionPlans([{ ...fixture, sql: 'SELECT 1;' }], [plan]),
    ).toContain('sqlHash');
    expect(
      await validateSubmittedExecutionPlans([fixture], [{ ...plan, planHash: 'sha256:changed' }]),
    ).toContain('planHash');
    expect(
      await validateSubmittedExecutionPlans([fixture], [{ ...plan, kind: 'single-statement' }]),
    ).toContain('kind');
    expect(
      await validateSubmittedExecutionPlans([fixture], [{ ...plan, statements: ['SELECT 1;'] }]),
    ).toContain('statements');
  });
});
