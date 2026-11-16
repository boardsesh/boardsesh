import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CncBoardConfigInput } from '@boardsesh/shared-schema';
import {
  GET_CNC_COMPUTATION,
  REQUEST_CNC_ARTWORK_VALIDATION,
  REQUEST_CNC_LAYOUT,
} from '@boardsesh/graphql/operations/cnc-packs';
const requests = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: requests.create }));
import { computeCnc } from '../configurator/cnc-computation-client';

const CONFIG: CncBoardConfigInput = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  options: {},
};
const queued = { id: 'owned-request', status: 'queued', result: null, errorCode: null };
beforeEach(() => {
  vi.useFakeTimers();
  requests.request.mockReset();
  requests.create.mockReset().mockReturnValue({ request: requests.request });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('async CNC computation client', () => {
  it('submits once, polls the same owned ID, and returns only the completed result', async () => {
    requests.request
      .mockResolvedValueOnce({ requestCncLayout: queued })
      .mockResolvedValueOnce({ cncComputation: { ...queued, status: 'running' } })
      .mockResolvedValueOnce({ cncComputation: { ...queued, status: 'ready', result: { panels: [1, 2, 3] } } });
    const result = computeCnc('layout', CONFIG, {
      authToken: 'buyer-token',
      includeHoles: true,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ panels: [1, 2, 3] });
    expect(requests.create.mock.calls).toEqual([['buyer-token']]);
    expect(requests.request.mock.calls.map(([request]) => request.document)).toEqual([
      REQUEST_CNC_LAYOUT,
      GET_CNC_COMPUTATION,
      GET_CNC_COMPUTATION,
    ]);
    expect(requests.request.mock.calls[0][0].variables).toEqual({ config: CONFIG, includeHoles: true });
    expect(requests.request.mock.calls.slice(1).map(([request]) => request.variables)).toEqual([
      { id: queued.id },
      { id: queued.id },
    ]);
  });

  it('uses the artwork mutation and accepts an already completed result without polling', async () => {
    requests.request.mockResolvedValue({
      requestCncArtworkValidation: { ...queued, status: 'ready', result: { ok: false } },
    });
    await expect(computeCnc('artwork', CONFIG, { signal: new AbortController().signal })).resolves.toEqual({
      ok: false,
    });
    expect(requests.request).toHaveBeenCalledOnce();
    expect(requests.request.mock.calls[0][0]).toMatchObject({
      document: REQUEST_CNC_ARTWORK_VALIDATION,
      variables: { config: CONFIG },
    });
  });

  it.each([
    ['ARTWORK_COLLISION', 'CNC_INVALID_CONFIG'],
    ['GENERATOR_ABORTED', 'CNC_WORKER_UNAVAILABLE'],
    ['CNC_WORKER_UNAVAILABLE', 'CNC_WORKER_UNAVAILABLE'],
  ])('maps terminal %s to %s', async (errorCode, expectedCode) => {
    requests.request.mockResolvedValue({ requestCncLayout: { ...queued, status: 'failed', errorCode } });
    await expect(computeCnc('layout', CONFIG, { signal: new AbortController().signal })).rejects.toThrow(expectedCode);
  });

  it('stops polling immediately when configuration changes abort its signal', async () => {
    requests.request.mockResolvedValue({ requestCncLayout: queued });
    const controller = new AbortController();
    const result = computeCnc('layout', CONFIG, { signal: controller.signal });
    const rejection = expect(result).rejects.toThrow('changed config');
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error('changed config'));
    await rejection;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests.request).toHaveBeenCalledOnce();
  });

  it('rejects a ready response after the original account scope becomes stale', async () => {
    let finish: ((response: unknown) => void) | undefined;
    requests.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    const result = computeCnc('layout', CONFIG, { signal: new AbortController().signal, isCurrent: () => current });
    const rejection = expect(result).rejects.toThrow('STALE_CNC_REQUEST');
    current = false;
    finish?.({ requestCncLayout: { ...queued, status: 'ready', result: { privateHoles: true } } });
    await rejection;
  });

  it('rejects a completed poll after the original account scope becomes stale', async () => {
    let current = true;
    requests.request.mockResolvedValueOnce({ requestCncLayout: queued }).mockImplementationOnce(async () => {
      current = false;
      return { cncComputation: { ...queued, status: 'ready', result: { privateHoles: true } } };
    });
    const result = computeCnc('layout', CONFIG, { signal: new AbortController().signal, isCurrent: () => current });
    const rejection = expect(result).rejects.toThrow('STALE_CNC_REQUEST');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it('fails closed when an owned computation disappears during polling', async () => {
    requests.request
      .mockResolvedValueOnce({ requestCncLayout: queued })
      .mockResolvedValueOnce({ cncComputation: null });
    const result = computeCnc('layout', CONFIG, { signal: new AbortController().signal });
    const rejection = expect(result).rejects.toThrow('CNC_WORKER_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it('bounds a queued computation to ninety seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('computation deadline')), milliseconds);
      return controller.signal;
    });
    requests.request.mockResolvedValueOnce({ requestCncLayout: queued }).mockResolvedValue({ cncComputation: queued });
    const result = computeCnc('layout', CONFIG, { signal: new AbortController().signal });
    const rejection = expect(result).rejects.toThrow('computation deadline');
    await vi.advanceTimersByTimeAsync(90_000);
    await rejection;
    const callsAtDeadline = requests.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests.request).toHaveBeenCalledTimes(callsAtDeadline);
    expect(timeout).toHaveBeenCalledWith(90_000);
  });
});
