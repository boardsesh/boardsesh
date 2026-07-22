import { gql } from 'graphql-request';
import type {
  CostEntry,
  RunningCostsReport,
  CreateCostEntryInput,
  UpdateCostEntryInput,
  DeleteCostEntryInput,
} from '@boardsesh/shared-schema';

// The CostEntry field set is written inline in each operation rather than shared
// via a `${const}` interpolation: graphql-tag-pluck (codegen) can't resolve a
// runtime interpolation and one here would drop every sibling document from the
// generated client. (Same reason as feedback.ts.)

// Admin only — the full editable list for /admin/costs.
export const COST_ENTRIES = gql`
  query CostEntries {
    costEntries {
      id
      kind
      category
      label
      amountCents
      currency
      startMonth
      endMonth
      note
    }
  }
`;

// Public — the rolled-up monthly report for the transparency screen.
export const RUNNING_COSTS = gql`
  query RunningCosts($months: Int) {
    runningCosts(months: $months) {
      currency
      latestMonthlyTotalCents
      months {
        month
        totalCents
        recurringCents
        incidentalCents
        byCategory {
          category
          amountCents
        }
      }
    }
  }
`;

export const CREATE_COST_ENTRY = gql`
  mutation CreateCostEntry($input: CreateCostEntryInput!) {
    createCostEntry(input: $input) {
      id
      kind
      category
      label
      amountCents
      currency
      startMonth
      endMonth
      note
    }
  }
`;

export const UPDATE_COST_ENTRY = gql`
  mutation UpdateCostEntry($input: UpdateCostEntryInput!) {
    updateCostEntry(input: $input) {
      id
      kind
      category
      label
      amountCents
      currency
      startMonth
      endMonth
      note
    }
  }
`;

export const DELETE_COST_ENTRY = gql`
  mutation DeleteCostEntry($input: DeleteCostEntryInput!) {
    deleteCostEntry(input: $input)
  }
`;

export type CostEntriesQueryResponse = {
  costEntries: CostEntry[];
};

export type RunningCostsQueryVariables = {
  months?: number | null;
};

export type RunningCostsQueryResponse = {
  runningCosts: RunningCostsReport;
};

export type CreateCostEntryMutationVariables = {
  input: CreateCostEntryInput;
};

export type CreateCostEntryMutationResponse = {
  createCostEntry: CostEntry;
};

export type UpdateCostEntryMutationVariables = {
  input: UpdateCostEntryInput;
};

export type UpdateCostEntryMutationResponse = {
  updateCostEntry: CostEntry;
};

export type DeleteCostEntryMutationVariables = {
  input: DeleteCostEntryInput;
};

export type DeleteCostEntryMutationResponse = {
  deleteCostEntry: boolean;
};
