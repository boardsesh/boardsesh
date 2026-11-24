import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ capture: vi.fn(), log: vi.fn() }));
vi.mock('../analytics/posthog', () => ({ captureBackendEvent: fixtures.capture }));
vi.mock('../../utils/logger', () => ({ logger: { info: fixtures.log, error: vi.fn() } }));

import {
  flushPublicApiUsage,
  recordGymMcpPendingAuthAddressRefusal,
  recordPublicApiRequest,
} from '../public-api-usage';

beforeEach(() => {
  flushPublicApiUsage();
  vi.clearAllMocks();
});

describe('gym MCP pending authentication usage counter', () => {
  it('aggregates refusals in one fixed anonymous MCP summary without per-request analytics events', () => {
    for (let refusal = 0; refusal < 7; refusal += 1) {
      recordGymMcpPendingAuthAddressRefusal();
      recordPublicApiRequest(undefined, 'mcp', 429, 2);
    }
    expect(fixtures.capture).not.toHaveBeenCalled();
    expect(fixtures.log).not.toHaveBeenCalled();
    flushPublicApiUsage();
    const summary = {
      client_id: '(unauthenticated)',
      surface: 'mcp',
      requests: 7,
      client_errors: 7,
      server_errors: 0,
      rate_limited: 7,
      connection_cap_refusals: 0,
      pending_auth_address_refusals: 7,
      p95_ms: 10,
    };
    expect(fixtures.capture).toHaveBeenCalledExactlyOnceWith('Public API Usage Summary', {
      systemDistinctId: 'system:public-api-usage',
      properties: summary,
    });
    expect(fixtures.log).toHaveBeenCalledExactlyOnceWith('[public-api-usage] per-minute summary', summary);
  });

  it('keeps authenticated MCP and other surfaces separate and does not infer address refusals from status429', () => {
    recordGymMcpPendingAuthAddressRefusal();
    recordPublicApiRequest(undefined, 'mcp', 429, 2);
    recordPublicApiRequest('verified-client', 'mcp', 429, 2);
    recordPublicApiRequest(undefined, 'api', 429, 2);
    recordPublicApiRequest(undefined, 'oauth', 429, 2);
    flushPublicApiUsage();
    expect(fixtures.capture).toHaveBeenCalledTimes(4);
    for (const event of fixtures.capture.mock.calls) {
      const summary = event[1].properties as Record<string, unknown>;
      expect(summary.pending_auth_address_refusals).toBe(
        summary.client_id === '(unauthenticated)' && summary.surface === 'mcp' ? 1 : 0,
      );
    }
  });

  it('resets the counter each flush while retaining ordinary429 usage', () => {
    recordGymMcpPendingAuthAddressRefusal();
    flushPublicApiUsage();
    recordPublicApiRequest(undefined, 'mcp', 429, 2);
    flushPublicApiUsage();
    expect(fixtures.capture.mock.calls.map((event) => event[1].properties.pending_auth_address_refusals)).toEqual([
      1, 0,
    ]);
    expect(fixtures.capture.mock.calls[1]?.[1].properties.rate_limited).toBe(1);
  });

  it('preserves the single anonymous MCP bucket even after dynamic app cardinality fills', () => {
    for (let client = 0; client < 1100; client += 1) recordPublicApiRequest(`verified-client-${client}`, 'api', 200, 2);
    recordPublicApiRequest('verified-client-overflow', 'mcp', 429, 2);
    recordGymMcpPendingAuthAddressRefusal();
    recordPublicApiRequest(undefined, 'mcp', 429, 2);
    flushPublicApiUsage();
    expect(fixtures.capture.mock.calls.length).toBeLessThanOrEqual(1004);
    const summaries = fixtures.capture.mock.calls.map((event) => event[1].properties as Record<string, unknown>);
    expect(summaries.filter((summary) => summary.pending_auth_address_refusals !== 0)).toEqual([
      expect.objectContaining({
        client_id: '(unauthenticated)',
        surface: 'mcp',
        requests: 1,
        pending_auth_address_refusals: 1,
      }),
    ]);
    expect(summaries).toContainEqual(
      expect.objectContaining({
        client_id: '(overflow)',
        surface: 'mcp',
        requests: 1,
        pending_auth_address_refusals: 0,
      }),
    );
  });
});
