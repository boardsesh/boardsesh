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
import {
  collectSuppliedVars,
  fetchClickHouseTtl,
  main,
  parseArgs,
  resetAuthScheme,
  suppliedVarKeys,
  ttlFromEngineFull,
} from './railway-apply';

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

describe('ttlFromEngineFull', () => {
  // Verbatim from ClickHouse 25.3 after the retention ALTER landed.
  const WITH_TTL =
    'MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (app_id, update_id, timestamp) ' +
    'TTL toDateTime(timestamp) + toIntervalDay(90) SETTINGS index_granularity = 8192';

  it('reads the TTL clause out of engine_full', () => {
    expect(ttlFromEngineFull(WITH_TTL)).toBe('toDateTime(timestamp) + toIntervalDay(90)');
  });

  it('stops at SETTINGS rather than swallowing it', () => {
    expect(ttlFromEngineFull(WITH_TTL)).not.toContain('index_granularity');
  });

  it('handles a TTL that runs to the end of the string', () => {
    expect(ttlFromEngineFull('MergeTree ORDER BY x TTL toDateTime(ts) + toIntervalDay(7)')).toBe(
      'toDateTime(ts) + toIntervalDay(7)',
    );
  });

  it('reports a table with no TTL as empty, which the plan reads as "no retention"', () => {
    const noTtl = 'MergeTree PARTITION BY toYYYYMM(bucket) ORDER BY (app_id) SETTINGS index_granularity = 8192';
    expect(ttlFromEngineFull(noTtl)).toBe('');
    expect(diffTableRetention(CLICKHOUSE_RETENTION[0], ttlFromEngineFull(noTtl))?.summary).toContain('no TTL set');
  });
});

describe('the retention remediation line', () => {
  // ClickHouse rejects a TTL on a DateTime64 column, and both of these are
  // DateTime64(9). A Fix: line that fails when pasted is worse than none.
  it('wraps the column so the suggested ALTER actually runs', () => {
    const change = diffTableRetention(CLICKHOUSE_RETENTION[0], '');
    expect(change?.detail).toContain(`MODIFY TTL toDateTime(${CLICKHOUSE_RETENTION[0].column})`);
  });

  it('suggests the same form when the window is merely wrong', () => {
    const change = diffTableRetention(CLICKHOUSE_RETENTION[1], 'toDateTime(timestamp) + toIntervalDay(31)');
    expect(change?.detail).toContain('MODIFY TTL toDateTime(timestamp)');
  });
});

describe('Railway authentication', () => {
  // Railway hands out two token kinds. A project token in an Authorization
  // header — the shipped bug — comes back HTTP 200 with `Not Authorized`, so a
  // naive `response.ok` check treats total failure as success.
  const PROJECT_DATA = {
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

  function headerOf(init: RequestInit | undefined, name: string): string | undefined {
    return (init?.headers as Record<string, string> | undefined)?.[name];
  }

  function silenceStdout(): () => void {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
    };
  }

  /** Accept exactly one scheme; answer the other the way Railway really does. */
  function stubAcceptingOnly(accepted: 'project' | 'account'): {
    fetch: typeof globalThis.fetch;
    schemesTried: string[];
  } {
    const schemesTried: string[] = [];
    const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const usedProject = headerOf(init, 'Project-Access-Token') !== undefined;
      schemesTried.push(usedProject ? 'project' : 'account');

      if ((accepted === 'project') !== usedProject) {
        return new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }], data: null }), { status: 200 });
      }

      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      const query = (JSON.parse(rawBody) as { query: string }).query;
      const data = query.includes('variables(') ? { variables: { CLICKHOUSE_URL: 'clickhouse://x/y' } } : PROJECT_DATA;
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof globalThis.fetch;

    return { fetch: fetchStub, schemesTried };
  }

  async function runAgainst(accepted: 'project' | 'account'): Promise<{ code: number; schemesTried: string[] }> {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const restoreStdout = silenceStdout();
    const stub = stubAcceptingOnly(accepted);

    globalThis.fetch = stub.fetch;
    process.env.RAILWAY_TOKEN = 'test-token';
    process.env.RAILWAY_PROJECT_ID = 'test-project';
    delete process.env.CLICKHOUSE_URL;

    try {
      return { code: await main([]), schemesTried: stub.schemesTried };
    } finally {
      restoreStdout();
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
    }
  }

  it('authenticates a project token, the kind this repo actually stores', async () => {
    const { code, schemesTried } = await runAgainst('project');
    expect(code).toBe(0);
    expect(schemesTried[0]).toBe('project');
  });

  it('falls back to Bearer for an account token instead of failing', async () => {
    const { code, schemesTried } = await runAgainst('account');
    expect(code).toBe(0);
    expect(schemesTried.slice(0, 2)).toEqual(['project', 'account']);
  });

  it('stops re-probing once a scheme answers', async () => {
    // Several requests are made per run; only the first should pay for a probe.
    const { schemesTried } = await runAgainst('account');
    expect(schemesTried.filter((scheme) => scheme === 'project')).toHaveLength(1);
  });

  it('does not leak a discovered scheme into the next run', async () => {
    await runAgainst('account');
    const { code, schemesTried } = await runAgainst('project');
    expect(code).toBe(0);
    expect(schemesTried[0]).toBe('project');
  });

  it('resets to the project scheme on demand', async () => {
    await runAgainst('account');
    resetAuthScheme();
    const { schemesTried } = await runAgainst('project');
    expect(schemesTried[0]).toBe('project');
  });
});

describe('fetchClickHouseTtl', () => {
  const ENGINE_WITH_TTL =
    'MergeTree ORDER BY (app_id) TTL toDateTime(timestamp) + toIntervalDay(90) SETTINGS index_granularity = 8192';

  async function withStub<T>(
    stub: typeof globalThis.fetch,
    run: () => Promise<T>,
  ): Promise<{ result?: T; error?: Error; calls: { url: string; init?: RequestInit }[] }> {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return stub(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    try {
      return { result: await run(), calls };
    } catch (error) {
      return { error: error as Error, calls };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const ok = (body: string) => (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;

  it('treats a missing DSN as "not checked" rather than "no drift"', async () => {
    expect(await fetchClickHouseTtl(undefined, 'expo_observe')).toBeNull();
  });

  it('reads the HTTP interface on 8123 when the DSN names the native port', async () => {
    const { calls } = await withStub(ok(''), () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    expect(calls[0].url).toBe('http://ch.internal:8123/');
  });

  it('keeps a non-default port, so a proxied endpoint still works', async () => {
    const { calls } = await withStub(ok(''), () =>
      fetchClickHouseTtl('clickhouse://u:p@proxy.rlwy.net:22497/expo_observe', 'expo_observe'),
    );
    expect(calls[0].url).toBe('http://proxy.rlwy.net:22497/');
  });

  it('sends the DSN credentials as ClickHouse auth headers', async () => {
    const { calls } = await withStub(ok(''), () =>
      fetchClickHouseTtl('clickhouse://someone:s3cret@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-ClickHouse-User']).toBe('someone');
    expect(headers['X-ClickHouse-Key']).toBe('s3cret');
  });

  it('parses the TTL out of each engine_full row', async () => {
    const body = `observe_metrics\t${ENGINE_WITH_TTL}\nobserve_logs\tMergeTree ORDER BY (app_id)\n`;
    const { result } = await withStub(ok(body), () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    expect(result).toEqual({
      observe_metrics: 'toDateTime(timestamp) + toIntervalDay(90)',
      observe_logs: '',
    });
  });

  it('surfaces an HTTP error instead of reporting no drift', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch;
    const { error } = await withStub(failing, () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/expo_observe', 'expo_observe'),
    );
    expect(error?.message).toContain('500');
  });

  it('refuses a database name that is not a plain identifier', async () => {
    const { error, calls } = await withStub(ok(''), () =>
      fetchClickHouseTtl('clickhouse://u:p@ch.internal:9000/x', "expo_observe'; DROP TABLE x --"),
    );
    expect(error?.message).toContain('plain identifier');
    expect(calls).toHaveLength(0);
  });
});
