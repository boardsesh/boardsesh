import { describe, expect, it, vi } from 'vitest';
import { buildSchema, graphql } from 'graphql';
import { GraphQLClient } from 'graphql-request';
import type { ReleaseContextInput } from '@boardsesh/shared-schema';
import { requestReport } from '../request-report';

const REPORT_INPUT_TYPES = [
  'SubmitAppFeedbackInput',
  'SubmitQaVerdictInput',
  'ReportClimbInput',
  'ReportSprayWallInput',
] as const;
type ReportInputType = (typeof REPORT_INPUT_TYPES)[number];
type ReportVariables = {
  input: { comment: string; screenshotKeys: string[]; releaseContext?: ReleaseContextInput | null };
};
const variables: ReportVariables = {
  input: {
    comment: 'The board disappeared while climbing. Keep these exact words.',
    screenshotKeys: ['feedback-screenshots/shot-1.jpg'],
    releaseContext: {
      channel: 'production',
      branch: 'pr-6476',
      updateId: 'running-update',
      runtimeVersion: 'runtime-1',
      isEmbeddedLaunch: false,
    },
  },
};

/** Run real GraphQL coercion behind graphql-request without network or native modules. */
function server(inputType: ReportInputType, supportsReleaseContext: boolean) {
  const schema = buildSchema(`
    input ReleaseContextInput {
      channel: String
      branch: String
      updateId: String
      runtimeVersion: String
      isEmbeddedLaunch: Boolean
    }
    input ${inputType} {
      comment: String!
      screenshotKeys: [String!]
      ${supportsReleaseContext ? 'releaseContext: ReleaseContextInput' : ''}
    }
    type Query { unused: Boolean }
    type Mutation { submitReport(input: ${inputType}!): Boolean! }
  `);
  const resolveReport = vi.fn(({ input }: ReportVariables) => {
    expect(input.comment).toBe(variables.input.comment);
    expect(input.screenshotKeys).toEqual(variables.input.screenshotKeys);
    return true;
  });
  const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)) as { query: string; variables: ReportVariables };
    const result = await graphql({
      schema,
      source: body.query,
      variableValues: body.variables,
      rootValue: { submitReport: resolveReport },
    });
    return new Response(JSON.stringify(result), {
      status: result.errors ? 400 : 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new GraphQLClient('https://reports.test/graphql', { fetch });
  const request = (requestVariables: ReportVariables) =>
    client.request<{ submitReport: boolean }>(
      `mutation Report($input: ${inputType}!) { submitReport(input: $input) }`,
      requestVariables,
    );
  return { request, fetch, resolveReport };
}

function rejection(message: string, extra: Record<string, unknown> = {}): unknown {
  return { response: { status: 400, errors: [{ message, ...extra }] } };
}
const unknownReleaseField = 'Field "releaseContext" is not defined by type "SubmitAppFeedbackInput".';

describe('requestReport preview compatibility', () => {
  it.each(REPORT_INPUT_TYPES)('submits to old %s schemas with exactly one resolver execution', async (inputType) => {
    const { request, fetch, resolveReport } = server(inputType, false);
    const originalVariables = structuredClone(variables);
    await expect(requestReport(request, variables, inputType)).resolves.toEqual({ submitReport: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resolveReport).toHaveBeenCalledTimes(1);
    expect(resolveReport.mock.calls[0]?.[0].input).toEqual({
      comment: variables.input.comment,
      screenshotKeys: variables.input.screenshotKeys,
    });
    expect(variables).toEqual(originalVariables);
  });

  it.each(REPORT_INPUT_TYPES)('preserves release identity on updated %s schemas', async (inputType) => {
    const { request, fetch, resolveReport } = server(inputType, true);
    await expect(requestReport(request, variables, inputType)).resolves.toEqual({ submitReport: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolveReport).toHaveBeenCalledTimes(1);
    expect(resolveReport.mock.calls[0]?.[0]).toEqual(variables);
  });

  it('does not retry old schemas that reject another input field as well', async () => {
    const { request, fetch, resolveReport } = server('SubmitAppFeedbackInput', false);
    const invalidVariables = { input: { ...variables.input, unrelatedField: 'invalid' } };
    await expect(requestReport(request, invalidVariables, 'SubmitAppFeedbackInput')).rejects.toMatchObject({
      response: { errors: expect.any(Array) },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolveReport).not.toHaveBeenCalled();
  });

  it.each([
    ['network failure', new Error('Network unavailable')],
    ['unstructured matching message', new Error(unknownReleaseField)],
    ['wrong input type', rejection('Field "releaseContext" is not defined by type "ReportClimbInput".')],
    ['different rejected field', rejection('Field "contactConsent" is not defined by type "SubmitAppFeedbackInput".')],
    ['authentication error', rejection(unknownReleaseField, { extensions: { code: 'UNAUTHENTICATED' } })],
    ['resolver error', rejection(unknownReleaseField, { path: ['submitReport'] })],
    ['server failure', { response: { status: 503, errors: [{ message: unknownReleaseField }] } }],
    [
      'partial execution',
      { response: { status: 200, data: { submitReport: true }, errors: [{ message: unknownReleaseField }] } },
    ],
  ])('does not retry %s', async (_label, error) => {
    const request = vi.fn<(requestVariables: ReportVariables) => Promise<boolean>>().mockRejectedValue(error);
    await expect(requestReport(request, variables, 'SubmitAppFeedbackInput')).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request that already omitted releaseContext', async () => {
    const error = rejection(unknownReleaseField);
    const request = vi.fn<(requestVariables: ReportVariables) => Promise<boolean>>().mockRejectedValue(error);
    await expect(
      requestReport(request, { input: { comment: 'Original report', screenshotKeys: [] } }, 'SubmitAppFeedbackInput'),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns the fallback error after a single retry', async () => {
    const error = rejection(unknownReleaseField);
    const request = vi.fn<(requestVariables: ReportVariables) => Promise<boolean>>().mockRejectedValue(error);
    await expect(requestReport(request, variables, 'SubmitAppFeedbackInput')).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
