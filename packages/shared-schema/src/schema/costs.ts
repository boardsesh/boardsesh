export const costsTypeDefs = /* GraphQL */ `
  """
  A single running-cost line item, maintained by admins on /admin/costs.
  \`recurring\` entries repeat every month from \`startMonth\` until \`endMonth\`
  (or forever while \`endMonth\` is null); \`incidental\` entries are one-offs that
  land in \`startMonth\` only. Month keys are 'YYYY-MM'. Amounts are integer cents.
  """
  type CostEntry {
    id: ID!
    "'recurring' | 'incidental'"
    kind: String!
    "'hosting' | 'ai' | 'domain' | 'other'"
    category: String!
    label: String!
    amountCents: Int!
    currency: String!
    startMonth: String!
    endMonth: String
    note: String
  }

  "Per-category cost total within a single month."
  type CostCategoryAmount {
    category: String!
    amountCents: Int!
  }

  """
  One month's rolled-up running cost: recurring entries active that month plus
  incidentals that landed in it, split by kind and by category.
  """
  type RunningCostsMonth {
    month: String!
    totalCents: Int!
    recurringCents: Int!
    incidentalCents: Int!
    byCategory: [CostCategoryAmount!]!
  }

  """
  Public running-cost report for the transparency screen: the last \`months\`
  calendar months through the current one (ascending), plus the current month's
  total for a headline figure.
  """
  type RunningCostsReport {
    currency: String!
    months: [RunningCostsMonth!]!
    latestMonthlyTotalCents: Int!
  }

  input CreateCostEntryInput {
    kind: String!
    category: String!
    label: String!
    amountCents: Int!
    currency: String
    startMonth: String!
    endMonth: String
    note: String
  }

  input UpdateCostEntryInput {
    id: ID!
    kind: String!
    category: String!
    label: String!
    amountCents: Int!
    currency: String
    startMonth: String!
    endMonth: String
    note: String
  }

  input DeleteCostEntryInput {
    id: ID!
  }
`;
