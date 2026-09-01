/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import {
  CLICKHOUSE_RETENTION,
  CLICKHOUSE_SERVICE_NAME,
  OTA_SERVICE_NAME,
  PLACEHOLDER_PATTERN,
  desiredRailwayState,
} from '../infra/railway/config';
import {
  buildPlan,
  classifyVar,
  diffService,
  diffServiceVars,
  diffTableRetention,
  findService,
  undeclaredServices,
  varKey,
} from '../infra/railway/plan';
import type { LiveState } from '../infra/railway/plan';
import { collectSuppliedVars, main, parseArgs, suppliedVarKeys } from './railway-apply';

const NO_SUPPLIED = { suppliedVars: new Set<string>() };

function liveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    services: [
      { id: 'svc-ota', name: OTA_SERVICE_NAME },
      { id: 'svc-ch', name: CLICKHOUSE_SERVICE_NAME },
    ],
    variables: { [OTA_SERVICE_NAME]: { CLICKHOUSE_URL: 'clickhouse://u:p@host:9000/expo_observe' } },
    clickhouseTtl: {
      observe_metrics: 'timestamp + toIntervalDay(90)',
      observe_logs: 'timestamp + toIntervalDay(30)',
    },
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ apply: false, help: false });
  });

  it('accepts --apply and the -- separator vp forwards', () => {
    expect(parseArgs(['--', '--apply'])).toEqual({ apply: true, help: false });
  });

  it('rejects a typo rather than silently dry-running', () => {
    expect(() => parseArgs(['--appply'])).toThrow(/Unknown flag/);
  });
});

describe('classifyVar', () => {
  it('treats an unfilled eoas placeholder as not set', () => {
    expect(classifyVar('<clickhouse://user:password@host:9000/xprem>')).toBe('placeholder');
    expect(PLACEHOLDER_PATTERN.test('<clickhouse://user:password@host:9000/xprem>')).toBe(true);
  });

  it('treats undefined and whitespace as absent', () => {
    expect(classifyVar(undefined)).toBe('absent');
    expect(classifyVar('   ')).toBe('absent');
  });

  it('treats a real DSN as set', () => {
    expect(classifyVar('clickhouse://u:p@host:9000/expo_observe')).toBe('set');
  });
});

describe('diffService', () => {
  it('is silent when the service exists', () => {
    expect(diffService(desiredRailwayState.services[0], liveState())).toBeNull();
  });

  it('blocks rather than creates a missing stateful service', () => {
    const live = liveState({ services: [{ id: 'svc-ota', name: OTA_SERVICE_NAME }] });
    const change = diffService(desiredRailwayState.services[1], live);
    expect(change).toMatchObject({ resource: 'service', blocked: true });
    expect(change?.detail).toMatch(/persistent volume/);
  });
});

describe('diffServiceVars', () => {
  const otaService = desiredRailwayState.services[0];

  it('is silent when the variable is set', () => {
    expect(diffServiceVars(otaService, liveState(), NO_SUPPLIED)).toEqual([]);
  });

  it('reports an absent variable and blocks it when no value was supplied', () => {
    const live = liveState({ variables: { [OTA_SERVICE_NAME]: {} } });
    const [change] = diffServiceVars(otaService, live, NO_SUPPLIED);
    expect(change).toMatchObject({ resource: 'env-var', blocked: true });
    expect(change.summary).toContain('absent');
  });

  it('unblocks the change when the caller supplied a value', () => {
    const live = liveState({ variables: { [OTA_SERVICE_NAME]: {} } });
    const supplied = { suppliedVars: new Set([varKey(OTA_SERVICE_NAME, 'CLICKHOUSE_URL')]) };
    const [change] = diffServiceVars(otaService, live, supplied);
    expect(change.blocked).toBe(false);
  });

  it('flags a placeholder that a naive is-it-set check would pass', () => {
    const live = liveState({
      variables: { [OTA_SERVICE_NAME]: { CLICKHOUSE_URL: '<clickhouse://user:password@host:9000/xprem>' } },
    });
    const [change] = diffServiceVars(otaService, live, NO_SUPPLIED);
    expect(change.summary).toContain('placeholder');
  });

  it('stays quiet about variables on a service that does not exist', () => {
    const live = liveState({ services: [] });
    expect(diffServiceVars(otaService, live, NO_SUPPLIED)).toEqual([]);
  });

  it('never puts a variable value in the plan output', () => {
    const secret = 'clickhouse://user:hunter2@host:9000/expo_observe';
    const live = liveState({ variables: { [OTA_SERVICE_NAME]: { CLICKHOUSE_URL: `<${secret}>` } } });
    const [change] = diffServiceVars(otaService, live, NO_SUPPLIED);
    expect(JSON.stringify(change)).not.toContain('hunter2');
  });
});

describe('diffTableRetention', () => {
  const metrics = CLICKHOUSE_RETENTION[0];

  it('accepts a matching TTL regardless of whitespace', () => {
    expect(diffTableRetention(metrics, 'timestamp  +  toIntervalDay(90)')).toBeNull();
  });

  it('reports a table with no TTL at all', () => {
    const change = diffTableRetention(metrics, '');
    expect(change).toMatchObject({ resource: 'clickhouse-ttl', blocked: true });
    expect(change?.detail).toMatch(/ALTER TABLE observe_metrics MODIFY TTL/);
  });

  it('reports a TTL that drifted to a different window', () => {
    const change = diffTableRetention(metrics, 'timestamp + toIntervalDay(7)');
    expect(change?.summary).toContain('not 90 days');
  });
});

describe('buildPlan', () => {
  it('is empty when everything matches', () => {
    expect(buildPlan(desiredRailwayState, liveState(), NO_SUPPLIED)).toEqual([]);
  });

  it('skips the retention check entirely when ClickHouse was not reachable', () => {
    const plan = buildPlan(desiredRailwayState, liveState({ clickhouseTtl: null }), NO_SUPPLIED);
    expect(plan.filter((change) => change.resource === 'clickhouse-ttl')).toEqual([]);
  });

  it('does not repeat variable drift for a service it already reported missing', () => {
    const live = liveState({ services: [], variables: {} });
    const plan = buildPlan(desiredRailwayState, live, NO_SUPPLIED);
    expect(plan.filter((change) => change.resource === 'env-var')).toEqual([]);
    expect(plan.filter((change) => change.resource === 'service')).toHaveLength(2);
  });

  it('reports missing TTLs', () => {
    const plan = buildPlan(desiredRailwayState, liveState({ clickhouseTtl: {} }), NO_SUPPLIED);
    expect(plan.filter((change) => change.resource === 'clickhouse-ttl')).toHaveLength(2);
  });
});

describe('undeclaredServices', () => {
  it('reports a foreign service without proposing to remove it', () => {
    const live = liveState({
      services: [
        { id: 'svc-ota', name: OTA_SERVICE_NAME },
        { id: 'svc-ch', name: CLICKHOUSE_SERVICE_NAME },
        { id: 'svc-pg', name: 'Postgres' },
      ],
    });
    expect(undeclaredServices(desiredRailwayState, live)).toEqual(['Postgres']);
    const plan = buildPlan(desiredRailwayState, live, NO_SUPPLIED);
    expect(plan.some((change) => /Postgres/.test(change.summary))).toBe(false);
  });
});

describe('supplied values', () => {
  it('picks up RAILWAY_VAR_* and ignores everything else', () => {
    const supplied = collectSuppliedVars({
      RAILWAY_VAR_CLICKHOUSE_URL: 'clickhouse://u:p@h:9000/expo_observe',
      RAILWAY_TOKEN: 'not-a-variable-value',
      RAILWAY_VAR_EMPTY: '  ',
    });
    expect([...supplied.keys()]).toEqual(['CLICKHOUSE_URL']);
  });

  it('only keys variables the config actually declares', () => {
    const supplied = new Map([
      ['CLICKHOUSE_URL', 'dsn'],
      ['JWT_SECRET', 'should-be-ignored'],
    ]);
    const keys = suppliedVarKeys(desiredRailwayState, supplied);
    expect([...keys]).toEqual([varKey(OTA_SERVICE_NAME, 'CLICKHOUSE_URL')]);
  });
});

describe('findService', () => {
  it('matches by name', () => {
    expect(findService(liveState(), OTA_SERVICE_NAME)?.id).toBe('svc-ota');
    expect(findService(liveState(), 'nope')).toBeNull();
  });
});

/**
 * End-to-end coverage of the I/O layer against a stubbed Railway API. The unit
 * tests above cover the diffing; this covers the wiring the diffing sits behind —
 * environment resolution, the variables fetch, the exit codes CI gates on, and the
 * promise that a DSN never reaches stdout.
 */
describe('main', () => {
  const SECRET_DSN = 'clickhouse://svc:hunter2@ch.railway.internal:9000/expo_observe';

  function stubRailway(variables: Record<string, string>): typeof globalThis.fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // The client always sends a JSON string; narrowing beats String() on the
      // BodyInit union, which would stringify a Blob to '[object Object]'.
      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(rawBody) as { query: string };
      const data = body.query.includes('variables(')
        ? { variables }
        : {
            project: {
              name: 'boardsesh-ota',
              environments: { edges: [{ node: { id: 'env-prod', name: 'production' } }] },
              services: {
                edges: [
                  { node: { id: 'svc-ota', name: OTA_SERVICE_NAME } },
                  { node: { id: 'svc-ch', name: CLICKHOUSE_SERVICE_NAME } },
                ],
              },
            },
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof globalThis.fetch;
  }

  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
    return {
      lines,
      restore: () => {
        console.log = originalLog;
        console.warn = originalWarn;
      },
    };
  }

  async function runMain(
    variables: Record<string, string>,
    env: Record<string, string> = {},
  ): Promise<{ code: number; output: string }> {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const captured = captureStdout();

    globalThis.fetch = stubRailway(variables);
    process.env.RAILWAY_TOKEN = 'test-token';
    process.env.RAILWAY_PROJECT_ID = 'test-project';
    delete process.env.CLICKHOUSE_URL;
    for (const [key, value] of Object.entries(env)) process.env[key] = value;

    try {
      const code = await main([]);
      return { code, output: captured.lines.join('\n') };
    } finally {
      captured.restore();
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  }

  it('exits 0 and reports in-sync when the variable is set', async () => {
    const { code, output } = await runMain({ CLICKHOUSE_URL: SECRET_DSN });
    expect(code).toBe(0);
    expect(output).toContain('In sync');
  });

  it('exits non-zero on drift so CI can gate on it', async () => {
    const { code, output } = await runMain({});
    expect(code).toBe(1);
    expect(output).toContain('CLICKHOUSE_URL is absent');
    expect(output).toContain('Dry-run');
  });

  it('skips the retention check, rather than passing it, without a ClickHouse DSN', async () => {
    const { output } = await runMain({ CLICKHOUSE_URL: SECRET_DSN });
    expect(output).toContain('Retention check skipped');
  });

  it('never prints a variable value, even the one it read', async () => {
    const { output } = await runMain({ CLICKHOUSE_URL: SECRET_DSN });
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(SECRET_DSN);
  });

  it('names a supplied value without printing it', async () => {
    const { output } = await runMain({}, { RAILWAY_VAR_CLICKHOUSE_URL: SECRET_DSN });
    expect(output).toContain('Values supplied for: CLICKHOUSE_URL');
    expect(output).not.toContain('hunter2');
  });
});
