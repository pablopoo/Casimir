import { sql } from 'drizzle-orm';
import {
  pgSchema,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { projects, deployments, users } from '../../schema.ts';
import type {
  Phase,
  Outcome,
  Target,
  RouteIdentity,
  Observation,
  ImageAlias,
  ImageId,
} from './types.ts';
const schema = pgSchema('casimir');
export const executionScope = schema.table(
  'execution_scope',
  {
    id: integer('id').primaryKey(),
    project_id: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
  },
  (t) => [check('execution_scope_id_check', sql`${t.id}=1`)],
);
export const executionOperations = schema.table(
  'execution_operations',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    deployment_id: text('deployment_id')
      .notNull()
      .unique()
      .references(() => deployments.id, { onDelete: 'restrict' }),
    actor_id: text('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    idempotency_key: text('idempotency_key').notNull(),
    input_hash: text('input_hash').notNull(),
    image_alias: text('image_alias').notNull().$type<ImageAlias>(),
    image_id: text('image_id').notNull().$type<ImageId>(),
    profile_hash: text('profile_hash').notNull(),
    phase: text('phase').notNull().default('queued').$type<Phase>(),
    outcome: text('outcome').$type<Outcome>(),
    previous_target: jsonb('previous_target').$type<Target>(),
    candidate_id: text('candidate_id'),
    executor_instance: text('executor_instance'),
    route_identity: jsonb('route_identity').$type<RouteIdentity>(),
    last_observation: jsonb('last_observation').$type<Observation>(),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.project_id, t.actor_id, t.idempotency_key),
    uniqueIndex('execution_one_blocking_project')
      .on(t.project_id)
      .where(sql`${t.phase} NOT IN ('succeeded','failed')`),
  ],
);
export const executorGuard = schema.table('executor_guard', {
  scope: text('scope').primaryKey(),
  container_id: text('container_id').notNull(),
  started_at: text('started_at').notNull(),
  instance: text('instance').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const executionMigrations = schema.table('schema_migrations', {
  version: integer('version').primaryKey(),
  hash: text('hash').notNull(),
  applied_at: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
