// Types for the running-cost transparency feature. Hand-written to mirror the
// `costs` SDL (packages/shared-schema/src/schema/costs.ts); consumed by the web
// admin panel and the mobile transparency screen.

export type CostEntryKind = 'recurring' | 'incidental';
export type CostCategory = 'hosting' | 'ai' | 'domain' | 'other';

export type CostEntry = {
  id: string;
  kind: string;
  category: string;
  label: string;
  amountCents: number;
  currency: string;
  startMonth: string;
  endMonth: string | null;
  note: string | null;
};

export type CostCategoryAmount = {
  category: string;
  amountCents: number;
};

export type RunningCostsMonth = {
  month: string;
  totalCents: number;
  recurringCents: number;
  incidentalCents: number;
  byCategory: CostCategoryAmount[];
};

export type RunningCostsReport = {
  currency: string;
  months: RunningCostsMonth[];
  latestMonthlyTotalCents: number;
};

export type CreateCostEntryInput = {
  kind: CostEntryKind;
  category: CostCategory;
  label: string;
  amountCents: number;
  currency?: string | null;
  startMonth: string;
  endMonth?: string | null;
  note?: string | null;
};

export type UpdateCostEntryInput = CreateCostEntryInput & { id: string };

export type DeleteCostEntryInput = { id: string };
