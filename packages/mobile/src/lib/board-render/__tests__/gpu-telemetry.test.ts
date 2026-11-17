import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ granted: true, track: vi.fn() }));
vi.mock('../../analytics', () => ({ track: controls.track }));
vi.mock('../../consent-state', () => ({ isProductAnalyticsGranted: () => controls.granted }));
import {
  classifyGpuFallback,
  reportGpuFallback,
  reportGpuFirstHolds,
  reportGpuPreparation,
  resolveGpuFailureScope,
} from '../gpu-telemetry';

let requestSequence = 0;
const context = { boardName: 'kilter', apiVersion: 5, surface: 'player' as const };
const requestId = () => `local-request-${requestSequence++}`;

beforeEach(() => {
  controls.granted = true;
  controls.track.mockClear();
  vi.restoreAllMocks();
});

describe('GPU diagnostics', () => {
  it('never lets a diagnostics failure interrupt rendering or fallback', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    controls.track.mockImplementationOnce(() => {
      throw new Error('SDK unavailable');
    });
    expect(() => reportGpuFallback(context, requestId(), 'render-failed', 'static')).not.toThrow();
  });
  it.each([
    ['presentation-timeout', 'presentation-timeout'],
    ['GPU allocation exceeds budget /private/secret.json', 'resource-limit'],
    ['unknown role 123456', 'unsupported-frame'],
    ['EGL context failed', 'context-failed'],
    ['atlas preparation failed', 'preparation-failed'],
    ['preparation cancelled', 'cancelled'],
    ['private UUID and arbitrary error detail', 'render-failed'],
    [undefined, 'render-failed'],
  ])('normalizes %s to the closed reason %s', (raw, expected) => {
    expect(classifyGpuFallback(raw)).toBe(expected);
  });

  it.each(['static', 'frame', 'context'] as const)('keeps the native %s scope', (scope) => {
    expect(resolveGpuFailureScope(scope, 'GPU command encoding unavailable', 'render-failed')).toBe(scope);
  });

  it.each([
    ['GPU command encoding unavailable', 'context'],
    ['GPU Timeout Error', 'context'],
    ['Discarded (victim of GPU error/recovery)', 'context'],
    ['GPU command failed', 'context'],
    ['Motion hold allocation failed', 'context'],
    ['GPU atlas-sized surface unavailable', 'context'],
    ['GPU shader compilation failed: out of memory', 'context'],
    [undefined, 'context'],
    ['Prototype supports at most 128 active holds', 'frame'],
    ['reason("Invalid render config")', 'static'],
    ['reason("Atlas preparation rejected config (-2)")', 'static'],
    ['reason("Invalid atlas layout")', 'static'],
    ['Invalid atlas vector', 'static'],
    ['GPU config too large', 'static'],
    ['GPU storage or viewport limit exceeded', 'static'],
    ['reason("Metal unavailable")', 'static'],
    ['GLES3.1 required', 'static'],
    ['Fragment storage buffers unavailable', 'static'],
    ['Frame timestamp extension unavailable', 'static'],
    // Exact Android API 3 (store 2.7.1) messages.
    ['GPU atlas rejected config or exceeded budget', 'static'],
    ['Failed requirement.', 'static'],
    ['Insufficient memory headroom for GPU atlas preparation', 'context'],
    ['Another layout occupies the GPU atlas budget', 'context'],
    ['GPU atlas residency exceeds 128 MiB', 'context'],
    ['GPU texture consumption timestamp unavailable', 'context'],
    ['Check failed.', 'context'],
  ] as const)('remembers an unscoped older-binary error %s only when it always repeats', (raw, expected) => {
    expect(resolveGpuFailureScope(undefined, raw, classifyGpuFallback(raw))).toBe(expected);
  });

  it('samples once per fallback and never sends raw request/config/error identifiers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const localRequest = requestId();
    reportGpuFallback(context, localRequest, 'resource-limit', 'static');
    reportGpuFallback(context, localRequest, 'render-failed', 'static');
    expect(controls.track).toHaveBeenCalledTimes(1);
    expect(controls.track).toHaveBeenCalledWith('Aura GPU Fallback', {
      board_name: 'kilter',
      api_version: 5,
      surface: 'player',
      sample_rate: 0.1,
      reason: 'resource-limit',
      failure_scope: 'static',
    });
    expect(JSON.stringify(controls.track.mock.calls)).not.toContain(localRequest);
  });

  it('does not repeatedly sample an initially unselected failure', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.9).mockReturnValue(0);
    const localRequest = requestId();
    reportGpuFallback(context, localRequest, 'render-failed', 'static');
    reportGpuFallback(context, localRequest, 'render-failed', 'static');
    expect(random).toHaveBeenCalledTimes(1);
    expect(controls.track).not.toHaveBeenCalled();
  });

  it('does not capture or sample without analytics consent, or on cancellation', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    controls.granted = false;
    reportGpuFallback(context, requestId(), 'render-failed', 'static');
    controls.granted = true;
    reportGpuFallback(context, requestId(), 'cancelled', 'frame');
    expect(random).not.toHaveBeenCalled();
    expect(controls.track).not.toHaveBeenCalled();
  });

  it('reports bounded cold costs while leaving warm frames silent', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ready = {
      requestId: requestId(),
      prepareMs: 12,
      uploadMs: 2,
      gpuMs: 1,
      atlasCacheHit: false,
      atlasBytes: 2048,
    };
    reportGpuPreparation(context, ready);
    reportGpuPreparation(context, { ...ready, requestId: requestId(), atlasCacheHit: true });
    expect(controls.track).toHaveBeenCalledTimes(1);
    expect(controls.track).toHaveBeenCalledWith('Aura GPU Prepared', {
      board_name: 'kilter',
      api_version: 5,
      surface: 'player',
      sample_rate: 0.1,
      prepare_ms: 12,
      upload_ms: 2,
      atlas_bytes: 2048,
    });
  });

  it.each(['gpu', 'cached-png-bridge', 'hedged-png'] as const)(
    'reports how a cold request first showed holds: %s, once per request',
    (source) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      const request = requestId();
      reportGpuFirstHolds(context, request, source, 312.6, source === 'hedged-png');
      reportGpuFirstHolds(context, request, 'gpu', 900, false);
      expect(random).toHaveBeenCalledTimes(1);
      expect(controls.track).toHaveBeenCalledExactlyOnceWith('Aura GPU First Holds', {
        board_name: 'kilter',
        api_version: 5,
        surface: 'player',
        sample_rate: 0.1,
        source,
        cold: source === 'hedged-png',
        first_holds_ms: 313,
      });
    },
  );

  it('bounds the first-holds time and follows consent', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    controls.granted = false;
    reportGpuFirstHolds(context, requestId(), 'gpu', 40, false);
    expect(controls.track).not.toHaveBeenCalled();
    controls.granted = true;
    reportGpuFirstHolds(context, requestId(), 'gpu', 3_600_000, true);
    reportGpuFirstHolds(context, requestId(), 'gpu', Number.NaN, false);
    expect(controls.track.mock.calls.map(([, props]) => props.first_holds_ms)).toEqual([60_000, null]);
  });
});
