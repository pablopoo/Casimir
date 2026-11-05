import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db.ts';
import { sandboxDrainCheckpoints } from './schema.ts';

const LEASE_MS = 120_000;

export type SandboxDrainPhase = 'deployments' | 'resources';
export type SandboxDrainCursor = Readonly<Record<string, string>>;
export type SandboxDrainCheckpoint = typeof sandboxDrainCheckpoints.$inferSelect;

export async function readSandboxDrainCheckpoint(db: Db): Promise<SandboxDrainCheckpoint | null> {
  const [row] = await db
    .select()
    .from(sandboxDrainCheckpoints)
    .where(eq(sandboxDrainCheckpoints.singleton, true));
  if (!row) {
    return null;
  }
  assertValidCheckpoint(row);
  return row;
}

function assertValidCheckpoint(row: SandboxDrainCheckpoint): void {
  if (
    (row.admission_protocol !== 0 &&
      row.admission_protocol !== 2 &&
      row.admission_protocol !== 3) ||
    !row.generation ||
    (row.state !== 'draining' && row.state !== 'complete') ||
    (row.phase !== 'deployments' && row.phase !== 'resources') ||
    !row.cursor ||
    (row.cursor.pass !== '1' && row.cursor.pass !== '2')
  ) {
    throw new Error('Sandbox drain database checkpoint is invalid.');
  }
}

export async function acquireSandboxDrainLease(
  db: Db,
): Promise<
  | { kind: 'acquired'; checkpoint: SandboxDrainCheckpoint; owner: string }
  | { kind: 'busy'; checkpoint: SandboxDrainCheckpoint }
  | { kind: 'complete'; checkpoint: SandboxDrainCheckpoint }
> {
  const owner = crypto.randomUUID();
  return db.transaction(async (tx) => {
    await tx
      .insert(sandboxDrainCheckpoints)
      .values({
        singleton: true,
        generation: crypto.randomUUID(),
        state: 'draining',
        phase: 'deployments',
        cursor: { pass: '1' },
      })
      .onConflictDoNothing();
    const [checkpoint] = await tx
      .select()
      .from(sandboxDrainCheckpoints)
      .where(eq(sandboxDrainCheckpoints.singleton, true))
      .for('update');
    if (!checkpoint) {
      throw new Error('Sandbox drain checkpoint could not be initialized.');
    }
    assertValidCheckpoint(checkpoint);
    if (checkpoint.state === 'complete') {
      return { kind: 'complete' as const, checkpoint };
    }
    if (checkpoint.lease_owner && checkpoint.lease_expires_at) {
      const [lease] = await tx
        .select({ active: sql<boolean>`${sandboxDrainCheckpoints.lease_expires_at} > now()` })
        .from(sandboxDrainCheckpoints)
        .where(eq(sandboxDrainCheckpoints.singleton, true));
      if (lease?.active) {
        return { kind: 'busy' as const, checkpoint };
      }
    }
    const [leased] = await tx
      .update(sandboxDrainCheckpoints)
      .set({
        lease_owner: owner,
        lease_expires_at: sql`now() + (${LEASE_MS} * interval '1 millisecond')`,
        updated_at: sql`now()`,
      })
      .where(eq(sandboxDrainCheckpoints.singleton, true))
      .returning();
    if (!leased) {
      throw new Error('Sandbox drain checkpoint lease could not be acquired.');
    }
    return { kind: 'acquired' as const, checkpoint: leased, owner };
  });
}

export async function checkpointSandboxDrain(
  db: Db,
  lease: { generation: string; owner: string },
  update: { phase: SandboxDrainPhase; cursor: SandboxDrainCursor },
): Promise<SandboxDrainCheckpoint> {
  const [row] = await db
    .update(sandboxDrainCheckpoints)
    .set({
      phase: update.phase,
      cursor: update.cursor,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(sandboxDrainCheckpoints.singleton, true),
        eq(sandboxDrainCheckpoints.generation, lease.generation),
        eq(sandboxDrainCheckpoints.lease_owner, lease.owner),
      ),
    )
    .returning();
  if (!row) {
    throw new Error('Sandbox drain lease was superseded; stale work was not checkpointed.');
  }
  return row;
}

export async function completeSandboxDrain(
  db: Db,
  lease: { generation: string; owner: string },
): Promise<SandboxDrainCheckpoint> {
  const now = new Date().toISOString();
  const [row] = await db
    .update(sandboxDrainCheckpoints)
    .set({
      state: 'complete',
      completed_at: now,
      updated_at: now,
      lease_owner: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(sandboxDrainCheckpoints.singleton, true),
        eq(sandboxDrainCheckpoints.generation, lease.generation),
        eq(sandboxDrainCheckpoints.lease_owner, lease.owner),
      ),
    )
    .returning();
  if (!row) {
    throw new Error('Sandbox drain lease was superseded; stale work cannot complete it.');
  }
  return row;
}
