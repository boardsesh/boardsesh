import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'board-qa-abort-'));
  directories.push(path);
  return path;
}
async function fresh() {
  vi.resetModules();
  return { evidence: await import('./evidence'), drivers: await import('./drivers') };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('first-cause observer abort', () => {
  it('preserves the first infrastructure error through later SIGINT and cancelled-scenario reporting', async () => {
    const { evidence: api } = await fresh();
    const cause = new api.QaFailure('Board observer heartbeat failed', 'infrastructure');
    expect(api.abortRun(cause)).toBe(cause);
    expect(api.abortRun()).toBe(cause);
    expect(api.abortRun(new api.QaFailure('later cancellation', 'blocked'))).toBe(cause);
    expect(() => api.requireRunning()).toThrow(cause);
    const proof = new api.Evidence(directory());
    await expect(
      proof.scenario('cancelled action', [], async () => {
        throw new Error('Maestro cancelled');
      }),
    ).rejects.toBe(cause);
    expect(JSON.parse(readFileSync(join(proof.directory, 'report.json'), 'utf8')).results[0]).toMatchObject({
      verdict: 'infrastructure',
      message: cause.message,
    });
  });
  it('cannot pass a polling observation or scenario that loses the observer during its awaited work', async () => {
    const { evidence: api } = await fresh();
    const cause = new api.QaFailure('Observer closed during query', 'infrastructure');
    await expect(
      api.until(
        async () => {
          api.abortRun(cause);
          return true;
        },
        Boolean,
        1000,
        'delivery',
      ),
    ).rejects.toBe(cause);
    const proof = new api.Evidence(directory());
    await expect(proof.scenario('late success', [], async () => {})).rejects.toBe(cause);
    expect(proof.results.every((result) => result.verdict !== 'passed')).toBe(true);
  });
  it('does not record a scenario as passed when its action resolves after the first observer failure', async () => {
    const { evidence: api } = await fresh();
    const proof = new api.Evidence(directory());
    const cause = new api.QaFailure('Observer failed while action resolved', 'infrastructure');
    await expect(
      proof.scenario('late action', [], async () => {
        api.abortRun(cause);
      }),
    ).rejects.toBe(cause);
    expect(proof.results[0]).toMatchObject({ verdict: 'infrastructure', message: cause.message });
  });
  it('the shared entrypoint handler kills an owned running process and rejects future Android mutations with that same cause', async () => {
    const { evidence: api, drivers } = await fresh();
    const root = directory(),
      started = join(root, 'started'),
      laterTap = join(root, 'later-tap');
    const proof = new api.Evidence(join(root, 'evidence'));
    const cause = new api.QaFailure('Board observer heartbeat failed', 'infrastructure');
    let notify: (reason: InstanceType<typeof api.QaFailure>) => void = () => {
      throw new Error('Observer handler not registered');
    };
    api.abortOnObserverFailure(
      {
        setObserverFailureHandler(handler) {
          notify = handler;
        },
      },
      drivers.cancelCommands,
      proof,
    );
    const running = drivers
      .command(
        process.execPath,
        [
          '-e',
          'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"started");setTimeout(()=>fs.writeFileSync(process.argv[2],"late mutation"),5000)',
          started,
          laterTap,
        ],
        10000,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    notify(cause);
    expect(await running).toBe(cause);
    await drivers.cancelCommands();
    expect(existsSync(laterTap)).toBe(false);
    const run = vi.fn(async () => '');
    const phone = new drivers.AndroidDriver(
      { id: 'owned', appId: 'com.boardsesh.app.dev', scheme: 'com.boardsesh.app', email: 'qa@example.com' },
      '/unused/adb',
      proof,
      run,
    );
    await expect(phone.foreground()).rejects.toBe(cause);
    await expect(phone.background()).rejects.toBe(cause);
    await expect(phone.restart()).rejects.toBe(cause);
    await expect(phone.flow('put')).rejects.toBe(cause);
    expect(run).not.toHaveBeenCalled();
    // Error artifacts remain read-only and available after cancellation.
    await phone.hierarchy();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      '/unused/adb',
      ['-s', 'owned', 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
    ]);
  });
  it('loss during an asynchronous WDA element lookup aborts the request and prevents the later click, while allowing diagnostic/close', async () => {
    const { evidence: api, drivers } = await fresh();
    const root = directory(),
      proof = new api.Evidence(join(root, 'evidence'));
    const phone = {
      id: '00008110-0000000000000001',
      appId: 'com.boardsesh.app',
      scheme: 'com.boardsesh.app',
      email: 'qa@example.com',
      wdaUrl: 'http://127.0.0.1:8211',
      runnerBundleId: 'com.boardsesh.boardqa.runner.xctrunner',
    };
    const requests: string[] = [];
    let deliverLookup: () => void = () => {
      throw new Error('No pending lookup');
    };
    let lookupSignal: AbortSignal | undefined;
    const response = (value: unknown) => new Response(JSON.stringify({ value }), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const route = `${options?.method ?? 'GET'} ${url.pathname}`;
        requests.push(route);
        if (url.pathname === '/status')
          return response({
            ready: true,
            build: { profileRunnerBundleId: phone.runnerBundleId, profileRunnerPid: 41 },
            ios: { sdkVersion: '27' },
          });
        if (url.pathname === '/session') return response({ sessionId: 'owned-session' });
        if (url.pathname.endsWith('/elements')) {
          lookupSignal = options?.signal ?? undefined;
          return await new Promise<Response>((resolveResponse) => {
            deliverLookup = () => resolveResponse(response([{ ELEMENT: 'owned-element' }]));
          });
        }
        if (url.pathname.endsWith('/source')) return response('<source/>');
        if (options?.method === 'DELETE') return response(null);
        throw new Error(`Unexpected WDA action ${route}`);
      }),
    );
    const run = vi.fn(async (_executable: string, args: string[]) => {
      writeFileSync(
        args[args.indexOf('--json-output') + 1],
        JSON.stringify({
          result: {
            runningProcesses: [
              {
                processIdentifier: 41,
                executable: '/Runner/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner',
              },
            ],
          },
        }),
      );
      return '';
    });
    const driver = new drivers.IosDriver(phone, proof, run);
    await driver.attach();
    const filename = join(root, 'tap.yaml');
    writeFileSync(
      filename,
      stringify({ appId: phone.appId }) + '---\n' + stringify([{ tapOn: { id: 'real-control' } }]),
    );
    const action = driver.flow(filename).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(requests.some((route) => route.endsWith('/elements'))).toBe(true));
    const cause = new api.QaFailure('Observer lost during selector lookup', 'infrastructure');
    api.abortRun(cause);
    deliverLookup();
    expect(await action).toBe(cause);
    expect(lookupSignal?.aborted).toBe(true);
    expect(requests.some((route) => route.endsWith('/click'))).toBe(false);
    await expect(driver.flow(filename)).rejects.toBe(cause);
    await driver.hierarchy();
    await driver.close();
    expect(requests).toContain('DELETE /session/owned-session');
  });
});
