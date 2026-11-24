import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { capture, warn } = vi.hoisted(() => ({ capture: vi.fn(), warn: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: capture }));
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: warn } }));

import {
  flushPublicApiUsage,
  recordPartnerConnectionCapRefusal,
  recordPublicApiRequest,
  startPublicApiUsageReporter,
  stopPublicApiUsageReporter,
} from '../services/public-api-usage';

describe('public API operational usage', () => {
  beforeEach(() => {
    stopPublicApiUsageReporter();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopPublicApiUsageReporter();
    vi.useRealTimers();
  });

  it('reports bounded aggregate latency and errors without climber identifiers', () => {
    for (let index = 0; index < 95; index++) recordPublicApiRequest('app_one', 'api', 200, 40);
    for (let index = 0; index < 5; index++) recordPublicApiRequest('app_one', 'api', 500, 900);
    flushPublicApiUsage();
    expect(capture).toHaveBeenCalledWith('Public API Usage Summary', {
      systemDistinctId: 'system:public-api-usage',
      properties: {
        client_id: 'app_one',
        surface: 'api',
        requests: 100,
        client_errors: 0,
        server_errors: 5,
        rate_limited: 0,
        connection_cap_refusals: 0,
        pending_auth_address_refusals: 0,
        p95_ms: 50,
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    flushPublicApiUsage();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('does not alert on ordinary expiry but alerts when connection caps are hit', () => {
    recordPublicApiRequest(undefined, 'api', 401, 10);
    flushPublicApiUsage();
    expect(warn).not.toHaveBeenCalled();
    recordPartnerConnectionCapRefusal('app_two');
    flushPublicApiUsage();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        client_id: 'app_two',
        connection_cap_refusals: 1,
        requests: 0,
        p95_ms: 0,
        error: expect.any(Error),
      }),
    );
  });

  it('bounds app cardinality and keeps API and OAuth counters separate', () => {
    for (let index = 0; index < 1100; index++) recordPublicApiRequest(`app_${index}`, 'api', 200, 1);
    recordPublicApiRequest('app_0', 'oauth', 429, 200);
    flushPublicApiUsage();
    expect(capture.mock.calls.length).toBeLessThanOrEqual(1002);
    expect(capture).toHaveBeenCalledWith(
      'Public API Usage Summary',
      expect.objectContaining({
        properties: expect.objectContaining({ client_id: '(overflow)', surface: 'api', requests: 100 }),
      }),
    );
  });

  it('starts once, flushes each minute and flushes remaining requests on shutdown', () => {
    startPublicApiUsageReporter();
    startPublicApiUsageReporter();
    recordPublicApiRequest('app_one', 'api', 200, 4);
    vi.advanceTimersByTime(60_000);
    expect(capture).toHaveBeenCalledTimes(1);
    recordPublicApiRequest('app_one', 'api', 204, 4);
    stopPublicApiUsageReporter();
    expect(capture).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
