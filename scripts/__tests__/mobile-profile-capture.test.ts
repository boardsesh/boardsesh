import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CdpClient,
  distribution,
  physicalFootprintMiB,
  selectDebuggerTarget,
  usefulStartup,
} from '../mobile-profile-capture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('profiling measurement validity', () => {
  it('rejects stale, loading, and malformed startup artifacts', () => {
    const artifact = { runId: 'current', marks: [{ name: 'home.useful.commit', timestampMs: 12, outcome: 'content' }] };
    expect(usefulStartup(artifact, 'previous')).toBe(true);
    expect(usefulStartup(artifact, 'current')).toBe(false);
    expect(usefulStartup({ ...artifact, marks: [{ name: 'root.commit', timestampMs: 1 }] }, null)).toBe(false);
    expect(usefulStartup(null, null)).toBe(false);
    for (const outcome of ['empty', 'offline', 'error'])
      expect(
        usefulStartup({ ...artifact, marks: [{ name: 'home.useful.commit', timestampMs: 12, outcome }] }, null),
      ).toBe(true);
  });
  it('distinguishes physical footprint from RSS and peak footprint', () => {
    expect(physicalFootprintMiB('Physical footprint:         195.7M\nPhysical footprint (peak): 294.3M')).toBe(195.7);
    expect(physicalFootprintMiB('Physical footprint: 1.5G')).toBe(1536);
    expect(physicalFootprintMiB('Physical footprint: 1024K')).toBe(1);
    expect(physicalFootprintMiB('RSS: 123M\nPhysical footprint (peak): 294.3M')).toBeNull();
  });
  it('retains individual sample order and reports nearest-rank distributions', () => {
    expect(distribution([3, 1, 2])).toEqual({ samples: [3, 1, 2], count: 3, min: 1, median: 2, p95: 3, max: 3 });
    expect(distribution([]).median).toBeNull();
  });
});

describe('Metro debugger target selection', () => {
  const selectedApp = 'com.boardsesh.app';
  const runtime = {
    appId: selectedApp,
    title: 'Boardsesh [React Native Bridgeless]',
    webSocketDebuggerUrl: 'ws://localhost:8097/inspector/debug?device=owned&page=1',
  };

  it('selects the actual React Native title without requiring the word Hermes', () => {
    expect(selectDebuggerTarget([runtime], selectedApp)).toBe(runtime);
  });

  it('uses the exact app identifier instead of a Hermes title or a shared prefix', () => {
    const developmentRuntime = {
      ...runtime,
      appId: 'com.boardsesh.app.dev',
      title: 'Hermes React Native',
      webSocketDebuggerUrl: 'ws://localhost:8097/inspector/debug?device=foreign&page=1',
    };
    expect(selectDebuggerTarget([developmentRuntime, runtime], selectedApp)).toBe(runtime);
    expect(selectDebuggerTarget([runtime, developmentRuntime], developmentRuntime.appId)).toBe(developmentRuntime);
    expect(selectDebuggerTarget([developmentRuntime], selectedApp)).toBeUndefined();
  });

  it('refuses multiple registered runtimes for the same application', () => {
    const secondRuntime = {
      ...runtime,
      webSocketDebuggerUrl: 'ws://localhost:8097/inspector/debug?device=second&page=1',
    };
    expect(() => selectDebuggerTarget([runtime, secondRuntime], selectedApp)).toThrow(/Multiple runtimes.*ambiguous/);
  });

  it('ignores malformed entries without selecting an unrelated application', () => {
    expect(
      selectDebuggerTarget(
        [
          null,
          'Hermes',
          42,
          {},
          { appId: selectedApp },
          { appId: selectedApp, webSocketDebuggerUrl: 123 },
          { ...runtime, appId: 'com.example.app' },
        ],
        selectedApp,
      ),
    ).toBeUndefined();
  });

  it.each([null, undefined, {}, 'Hermes'])('rejects a malformed target-list response: %j', (targets) => {
    expect(() => selectDebuggerTarget(targets, selectedApp)).toThrow(/Invalid Metro debugger target list/);
  });
});

describe('CDP connection ownership and Origin', () => {
  it.each(['ws://other-host.example:8097/inspector/debug', 'ws://localhost:8081/inspector/debug'])(
    'rejects a debugger endpoint outside the selected Metro: %s',
    async (endpoint) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          json: async () => [{ appId: 'com.boardsesh.app', webSocketDebuggerUrl: endpoint }],
        })),
      );
      await expect(CdpClient.connect(8097)).rejects.toThrow(/outside the selected local Metro/);
    },
  );

  it("supplies Metro's required localhost Origin to the actual WebSocket handshake", async () => {
    const port = 8097;
    const endpoint = `ws://localhost:${port}/inspector/debug?device=fixture&page=1`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => [
          {
            appId: 'com.boardsesh.app.dev',
            title: 'Boardsesh [React Native Bridgeless]',
            webSocketDebuggerUrl: endpoint,
          },
        ],
      })),
    );
    // Exercise the pinned ws constructor, intercepting only its HTTP transport.
    // This catches an omitted Origin without binding a port or using Metro/RN.
    const interceptedTransport = new Error('Fixture intercepted the HTTP upgrade before network I/O.');
    let upgradeOptions: unknown;
    vi.spyOn(http, 'request').mockImplementation((options: unknown) => {
      upgradeOptions = options;
      throw interceptedTransport;
    });
    await expect(CdpClient.connect(port, 'com.boardsesh.app.dev')).rejects.toBe(interceptedTransport);
    expect(upgradeOptions).toMatchObject({
      host: 'localhost',
      port: String(port),
      path: '/inspector/debug?device=fixture&page=1',
      headers: { Origin: `http://localhost:${port}`, Upgrade: 'websocket' },
    });
  });
});
