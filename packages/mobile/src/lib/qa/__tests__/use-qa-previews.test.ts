import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QA_PREVIEWS_MAX_PR_NUMBERS } from '@boardsesh/shared-schema';

// React Query is stubbed rather than rendered: both hooks here are thin
// wrappers whose whole job is the payload they hand the client, so capturing
// `useQuery` / `useMutation` options lets the tests call that payload builder
// directly with no renderer in the way.
const queryOptions = vi.hoisted(() => ({ captured: null as Record<string, unknown> | null }));
const mutationOptions = vi.hoisted(() => ({ captured: null as Record<string, unknown> | null }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: Record<string, unknown>) => {
    queryOptions.captured = options;
    return { data: undefined };
  },
  useMutation: (options: Record<string, unknown>) => {
    mutationOptions.captured = options;
    return { mutateAsync: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const device = vi.hoisted(() => ({
  modelName: 'iPhone 17 Pro' as string | null,
  osVersion: '26.1' as string | null,
}));
vi.mock('expo-device', () => ({
  get modelName() {
    return device.modelName;
  },
  get osVersion() {
    return device.osVersion;
  },
}));

vi.mock('expo-updates', () => ({
  updateId: 'update-abc',
  runtimeVersion: 'fingerprint-1',
  createdAt: new Date('2026-08-26T09:30:00.000Z'),
}));

const request = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../feedback/use-submit-app-feedback', () => ({
  getMobilePlatform: () => 'ios',
  getNativeAppVersion: () => '2.3.1',
}));

import { useQaPreviews, useSubmitQaVerdict } from '../use-qa-previews';

type CapturedVariables = { prNumbers: number[]; includeBuilding: boolean };

/** The variables the query would send, by running the captured `queryFn`. */
async function runQueryFn(): Promise<CapturedVariables> {
  request.mockResolvedValue({ qaPreviews: [] });
  await (queryOptions.captured?.queryFn as () => Promise<unknown>)();
  return request.mock.calls.at(-1)?.[1] as CapturedVariables;
}

beforeEach(() => {
  request.mockReset();
  queryOptions.captured = null;
  mutationOptions.captured = null;
  device.modelName = 'iPhone 17 Pro';
  device.osVersion = '26.1';
});

describe('useSubmitQaVerdict', () => {
  const submission = { prNumber: 4792, branch: 'pr-4792', verdict: 'approved' as const, comment: null };

  it('sends the handset alongside the bundle identity', async () => {
    request.mockResolvedValue({ submitQaVerdict: { id: '17' } });
    useSubmitQaVerdict();

    await (mutationOptions.captured?.mutationFn as (input: typeof submission) => Promise<unknown>)(submission);

    expect(request.mock.calls[0][1]).toEqual({
      input: {
        prNumber: 4792,
        branch: 'pr-4792',
        verdict: 'approved',
        comment: null,
        platform: 'ios',
        deviceModel: 'iPhone 17 Pro',
        osVersion: '26.1',
        appVersion: '2.3.1',
        updateId: 'update-abc',
        runtimeVersion: 'fingerprint-1',
        bundleCreatedAt: '2026-08-26T09:30:00.000Z',
      },
    });
  });

  it('sends nulls rather than dropping the fields when the OS names neither', async () => {
    // A simulator, or the browser. The backend renders "unknown" for these; a
    // missing key would be a different thing on the wire than a known absence.
    device.modelName = null;
    device.osVersion = null;
    request.mockResolvedValue({ submitQaVerdict: { id: '17' } });
    useSubmitQaVerdict();

    await (mutationOptions.captured?.mutationFn as (input: typeof submission) => Promise<unknown>)(submission);

    const { input } = request.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(input).toHaveProperty('deviceModel', null);
    expect(input).toHaveProperty('osVersion', null);
  });
});

describe('useQaPreviews', () => {
  it('asks about every PR when the list is within the bound', async () => {
    useQaPreviews([30, 10, 20]);

    expect(await runQueryFn()).toEqual({ prNumbers: [10, 20, 30], includeBuilding: false });
  });

  it('keeps the caller’s freshest PRs when the list runs past the bound', async () => {
    // The pick screen passes its branches freshest first, and the backend
    // REJECTS an over-long list rather than truncating it — one number too many
    // and every row loses its title, risk and plan. So the trim has to happen
    // here, and it has to cost the oldest previews their metadata, not the
    // highest-numbered ones: sorting first would drop the newest PRs.
    const freshestFirst = Array.from({ length: QA_PREVIEWS_MAX_PR_NUMBERS + 50 }, (_, index) => 5000 - index);
    useQaPreviews(freshestFirst);

    const { prNumbers } = await runQueryFn();
    expect(prNumbers).toHaveLength(QA_PREVIEWS_MAX_PR_NUMBERS);
    expect(prNumbers.at(-1)).toBe(5000);
    expect(prNumbers[0]).toBe(5000 - QA_PREVIEWS_MAX_PR_NUMBERS + 1);
    // The 50 oldest branches are the ones that go without metadata.
    expect(prNumbers).not.toContain(5000 - QA_PREVIEWS_MAX_PR_NUMBERS);
  });

  it('does not mutate the array the caller passed', () => {
    const prNumbers = [30, 10, 20];
    useQaPreviews(prNumbers);

    expect(prNumbers).toEqual([30, 10, 20]);
  });
});
