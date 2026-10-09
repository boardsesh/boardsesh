/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ownWdaIdentity,
  percentagePoint,
  PhysicalIosFlow,
  selectorPredicate,
  swipeActions,
  visibleRowProof,
  wdaRequest,
} from '../lib/mobile-profile-wda';
import { IOS_UI_RUNNER_ID, IOS_UI_SOURCE_COMMIT } from '../mobile-profile-ios-driver';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function status() {
  return {
    value: {
      ready: true,
      ios: {},
      build: {
        profileRunnerBundleId: `${IOS_UI_RUNNER_ID}.xctrunner`,
        profileRunnerPid: 123,
        profileRunnerSourceCommit: IOS_UI_SOURCE_COMMIT,
      },
    },
  };
}

describe('owned physical iPhone UI driver', () => {
  it('refuses an occupied endpoint before any session replacement', async () => {
    const requests: string[] = [];
    const request = async (path: string): Promise<unknown> => {
      requests.push(path);
      return { ...status(), sessionId: 'existing-session' };
    };
    const flow = new PhysicalIosFlow(request, 'http://127.0.0.1:8199/mark', 'token', '/unused');
    await expect(flow.attach(123)).rejects.toThrow('active session');
    expect(requests).toEqual(['/status']);
  });
  it('rejects foreign runner identities and simulator endpoints before session creation', () => {
    expect(ownWdaIdentity(status()).pid).toBe(123);
    expect(() =>
      ownWdaIdentity({
        value: {
          ...status().value,
          build: {
            ...status().value.build,
            profileRunnerBundleId: 'com.boardsesh.moonboardauth.WebDriverAgentRunner.xctrunner',
          },
        },
      }),
    ).toThrow('owned');
    expect(() => ownWdaIdentity({ value: { ...status().value, ios: { simulatorVersion: '26' } } })).toThrow('physical');
  });
  it('uses literal supported accessibility selectors and physical point geometry', () => {
    expect(selectorPredicate({ id: 'climb-row' })).toContain('name MATCHES');
    expect(selectorPredicate({ id: 'climb-row', text: '(?s).*First climb.*', index: 0 })).toContain(
      "name MATCHES 'climb-row' AND (label MATCHES",
    );
    expect(selectorPredicate({ text: "Climber's tick" })).toContain("Climber\\'s tick");
    expect(() => selectorPredicate({ id: 'row', below: 'Header' })).toThrow('supported');
    expect(percentagePoint('75%,50%', { x: 10, y: 100, width: 200, height: 40 })).toEqual({ x: 160, y: 120 });
    expect(() => percentagePoint('101%,50%', { x: 0, y: 0, width: 390, height: 844 })).toThrow();
  });
  it('moves immediately with W3C duration rather than press-and-hold drag duration', () => {
    const gesture = swipeActions({ x: 20, y: 100 }, { x: 120, y: 100 }, 450);
    expect(gesture.actions[0].actions.map((action) => action.type)).toEqual([
      'pointerMove',
      'pointerDown',
      'pointerMove',
      'pointerUp',
    ]);
    const move = gesture.actions[0].actions[2];
    expect('duration' in move ? move.duration : undefined).toBe(450);
    expect(() => swipeActions({ x: 0, y: 0 }, { x: 1, y: 1 }, 5000)).toThrow('duration');
  });
  it('proves logical text inside a visible row rather than a matching external banner', () => {
    const row = {
      rawIdentifier: 'climb-row',
      isVisible: '1',
      rect: { x: 0, y: 100, width: 390, height: 80 },
      children: [{ label: 'First climb', isVisible: '1' }],
    };
    expect(visibleRowProof({ children: [row] }, 'climb-row', 0, 'First climb').rect).toEqual(row.rect);
    expect(() =>
      visibleRowProof({ children: [{ label: 'Other climb', isVisible: '1' }, row] }, 'climb-row', 0, 'Other climb'),
    ).toThrow('row subtree');
    expect(() => visibleRowProof({ children: [{ ...row, isVisible: '0' }] }, 'climb-row', 0, 'First climb')).toThrow(
      'missing',
    );
    expect(
      visibleRowProof(
        { children: [{ ...row, children: [], label: 'First climb, 1.9k sends · V4' }] },
        'climb-row',
        0,
        'First climb',
      ).text,
    ).toBe('First climb');
    expect(() =>
      visibleRowProof(
        { children: [{ ...row, children: [], label: 'First climb extra, V4' }] },
        'climb-row',
        0,
        'First climb',
      ),
    ).toThrow('row subtree');
  });
  it('retains bounded error code/message without echoing an entire WDA response', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            value: { error: 'invalid selector', message: "Unknown 'identifier'", stacktrace: 'excluded' },
          }),
          { status: 400 },
        ),
    );
    await expect(wdaRequest('http://127.0.0.1:8211')('/elements', 'POST')).rejects.toThrow(
      "invalid selector: Unknown 'identifier'",
    );
  });
  it('attaches without app restart, preserves YAML boundaries, writes screenshots and detaches without termination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-wda-test-'));
    temporaryDirectories.push(directory);
    const filename = join(directory, 'flow.yaml'),
      marker = resolve('scripts/fixtures/mobile-profile/mark.js');
    writeFileSync(
      filename,
      `appId: com.boardsesh.app.perf\n---\n- assertVisible: {id: home-screen}\n- runScript:\n    file: ${marker}\n    env: {SEGMENT: climbs, BOUNDARY: start}\n- prepareTouch: {key: first-tap, settleMs: 100, tapOn: {text: Climbs, index: 0}}\n- runScript:\n    file: ${marker}\n    env: {SEGMENT: climbs.touch01.before, BOUNDARY: sample}\n- executePreparedTouch: first-tap\n- runScript:\n    file: ${marker}\n    env: {SEGMENT: climbs.touch01.after, BOUNDARY: sample}\n- swipe: {from: {id: climb-row}, start: '75%,50%', end: '95%,50%', endRelativeTo: from, maxDistance: 191, duration: 450}\n- takeScreenshot: climbs-loaded\n- saveUIHierarchy: climbs-tree\n- runScript:\n    file: ${marker}\n    env: {SEGMENT: climbs, BOUNDARY: end}\n`,
    );
    const events: string[] = [];
    const eventTimes = new Map<string, number>();
    const requests: { path: string; method?: string; body?: unknown }[] = [];
    let attached = false;
    const request = async (path: string, method?: string, body?: unknown): Promise<unknown> => {
      requests.push({ path, method, body });
      events.push(path);
      if (path === '/status') return { ...status(), sessionId: attached ? 'owned-session' : null };
      if (path === '/session') {
        attached = true;
        return { value: { sessionId: 'owned-session' } };
      }
      if (path.endsWith('/elements')) return { value: [{ ELEMENT: 'row' }] };
      if (path.endsWith('/rect')) return { value: { x: 20, y: 60, width: 100, height: 40 } };
      if (path.endsWith('/window/size')) return { value: { width: 390, height: 844 } };
      if (path === '/screenshot') return { value: Buffer.from('test-image').toString('base64') };
      if (path.endsWith('/source?format=json')) return { value: { rawIdentifier: 'climb-row' } };
      return { value: {} };
    };
    const marks: unknown[] = [];
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : undefined;
      if (incoming.url === '/mark') {
        const name = '/mark:' + String((body as { segment: string }).segment);
        events.push(name);
        eventTimes.set(name, Date.now());
      }
      const payload =
        incoming.url === '/mark'
          ? (marks.push(body), { acknowledged: true })
          : await request(incoming.url ?? '', incoming.method, body);
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(JSON.stringify(payload));
    });
    await new Promise<void>((ready, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', ready);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback HTTP test address');
    const origin = `http://127.0.0.1:${address.port}`;
    const flow = new PhysicalIosFlow(wdaRequest(origin), `${origin}/mark`, 'ephemeral-token', directory);
    try {
      await flow.attach();
      await flow.run(filename);
      await flow.detach();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
    expect(requests.find((entry) => entry.path === '/session')?.body).toEqual({
      capabilities: {
        alwaysMatch: {
          bundleId: 'com.boardsesh.app.perf',
          forceAppLaunch: false,
          shouldTerminateApp: false,
          shouldWaitForQuiescence: false,
          waitForIdleTimeout: 0,
        },
      },
    });
    expect(marks).toEqual([
      { token: 'ephemeral-token', segment: 'climbs', boundary: 'start' },
      { token: 'ephemeral-token', segment: 'climbs.touch01.before', boundary: 'sample' },
      { token: 'ephemeral-token', segment: 'climbs.touch01.after', boundary: 'sample' },
      { token: 'ephemeral-token', segment: 'climbs', boundary: 'end' },
    ]);
    const narrowStart = events.indexOf('/mark:climbs.touch01.before'),
      narrowEnd = events.indexOf('/mark:climbs.touch01.after');
    expect(events.slice(narrowStart + 1, narrowEnd)).toEqual(['/session/owned-session/wda/tap']);
    expect(
      eventTimes.get('/mark:climbs.touch01.after')! - eventTimes.get('/mark:climbs.touch01.before')!,
    ).toBeGreaterThanOrEqual(90);
    expect(flow.evidence.find((entry) => entry.action === 'executed-prepared-touch')).toMatchObject({
      requestedSettleMs: 100,
    });
    expect(readFileSync(join(directory, 'climbs-loaded.png'), 'utf8')).toBe('test-image');
    expect(JSON.parse(readFileSync(join(directory, 'climbs-tree.json'), 'utf8'))).toEqual({
      rawIdentifier: 'climb-row',
    });
    expect(flow.evidence.find((entry) => entry.action === 'native-touch')).toMatchObject({
      start: { x: 95, y: 80 },
      end: { x: 115, y: 80 },
      distance: 20,
      endRelativeTo: 'from',
    });
    expect(requests.at(-1)).toEqual({ path: '/session/owned-session', method: 'DELETE', body: undefined });
    expect(requests.some((entry) => /launch|terminate|shutdown/.test(entry.path))).toBe(false);
  });
});
