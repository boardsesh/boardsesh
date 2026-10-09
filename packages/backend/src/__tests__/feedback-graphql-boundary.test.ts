import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  persistedRows: [] as Array<Record<string, unknown>>,
  createFeedbackGithubIssue: vi.fn(),
}));

vi.mock('../db/client', () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        mocks.persistedRows.push(row);
        return { returning: async () => [{ id: BigInt(mocks.persistedRows.length), ...row }] };
      },
    }),
  },
}));

vi.mock('../services/github-feedback', () => ({
  BUG_SOURCES: new Set(['shake-bug', 'drawer-bug']),
  createFeedbackGithubIssue: mocks.createFeedbackGithubIssue,
}));

vi.mock('@boardsesh/email', () => ({ sendBugReportIssueEmail: vi.fn() }));

vi.mock('../graphql/index', async () => {
  const { makeExecutableSchema } = await import('@graphql-tools/schema');
  const { typeDefs } = await import('@boardsesh/shared-schema/schema');
  const GraphQLJSON = (await import('graphql-type-json')).default;
  const { feedbackMutations } = await import('../graphql/resolvers/feedback/mutations');
  return {
    schema: makeExecutableSchema({
      typeDefs,
      resolvers: {
        JSON: GraphQLJSON,
        Mutation: { submitAppFeedback: feedbackMutations.submitAppFeedback },
      },
    }),
  };
});

import { schema } from '../graphql/index';
import { createYogaInstance } from '../graphql/yoga';

const SUBMIT_FEEDBACK = `
  mutation SubmitFeedback($input: SubmitAppFeedbackInput!) {
    submitAppFeedback(input: $input)
  }
`;
const yoga = createYogaInstance();

type GraphQLCase = {
  name: string;
  diagnostics: unknown;
  expectedDiagnostics?: Record<string, unknown>;
};

const cases: GraphQLCase[] = [
  {
    name: 'keeps valid identifiers and false flags while dropping an invalid field and unknown key',
    diagnostics: {
      schemaVersion: 1,
      reportId: 'report-123',
      previousLaunchCrashed: false,
      otaIsEmbedded: false,
      otaBranch: 42,
      futureCorrelationKey: 'must-not-be-stored',
    },
    expectedDiagnostics: {
      schemaVersion: 1,
      reportId: 'report-123',
      previousLaunchCrashed: false,
      otaIsEmbedded: false,
    },
  },
  {
    name: 'discards a non-object diagnostics value without losing the report',
    diagnostics: 'broken',
  },
  {
    name: 'strips an unknown future diagnostics key before persistence',
    diagnostics: { reportId: 'report-future', futureCorrelationKey: 'must-not-be-stored' },
    expectedDiagnostics: { reportId: 'report-future' },
  },
];

beforeEach(() => {
  mocks.persistedRows.length = 0;
  mocks.createFeedbackGithubIssue.mockReset().mockResolvedValue({ status: 'skipped' });
});

describe('submitAppFeedback diagnostics GraphQL boundary', () => {
  it.each(cases)('$name', async ({ diagnostics, expectedDiagnostics }) => {
    const contextUrl = 'https://feedback.example.test/report';
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/graphql-response+json',
      },
      body: JSON.stringify({
        query: SUBMIT_FEEDBACK,
        variables: {
          input: {
            comment: 'The board screen freezes during a report',
            platform: 'ios',
            source: 'shake-bug',
            context: { url: contextUrl, diagnostics },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { submitAppFeedback: true } });
    expect(mocks.persistedRows).toHaveLength(1);
    const persistedContext = mocks.persistedRows[0].context;
    expect(persistedContext).toEqual(
      expectedDiagnostics ? { url: contextUrl, diagnostics: expectedDiagnostics } : { url: contextUrl },
    );
  });

  it('keeps diagnostic output explicitly typed rather than opaque JSON', () => {
    const feedbackContextType = schema.getType('AppFeedbackContext');
    expect(feedbackContextType?.toString()).toBe('AppFeedbackContext');
    if (!feedbackContextType || !('getFields' in feedbackContextType)) {
      throw new Error('Expected AppFeedbackContext output type');
    }
    expect(feedbackContextType.getFields().diagnostics.type.toString()).toBe('FeedbackDiagnostics');
  });
});
