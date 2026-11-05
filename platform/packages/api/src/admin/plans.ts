import type { PlatformPlanCatalog } from '@void/platform/plans';
import type { PlanCatalogAction } from '../operator/plans.ts';

export type AdminPlanPreview = {
  action: PlanCatalogAction;
  target: string;
  body: Record<string, unknown>;
  expectedRevision: number;
  before: PlatformPlanCatalog;
  after: PlatformPlanCatalog;
  affectedAccounts: number;
  warnings: Array<string>;
  overLimitAccounts: Array<{ id: string; login: string; reasons: Array<string> }>;
  usageSampleSize: number;
};

export type AdminPlanProgress = {
  revision: number;
  complete: boolean;
  processed: number;
  cursor: string | null;
  error: string | null;
};
