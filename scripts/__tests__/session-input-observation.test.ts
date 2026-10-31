import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';
import {
  blockedOperationNames,
  classifyAttempt,
  hierarchyNode,
  inside,
  inspectVisibility,
  mayAttemptFreshLaunch,
  observationHttpPolicy,
  OBSERVATION_STAGES,
  permitGraphqlRead,
  redactedTrace,
  singleTapFlow,
} from '../lib/session-input-observation/guards';
import { applyObservationWrapper } from '../lib/session-input-observation/wrapper';
import { startObservationProxy, websocketText } from '../lib/session-input-observation/proxy';

const fixture = JSON.parse(
  readFileSync('scripts/__tests__/fixtures/showcase-session-visibility/ios-maestro-2.6.1.json', 'utf8'),
) as { hierarchy: unknown };
function observedHierarchy() {
  const parent = hierarchyNode(structuredClone(fixture.hierarchy));
  parent.attributes = { ...parent.attributes, enabled: 'true', value: '1' };
  parent.children.forEach((child) => {
    child.attributes.enabled = 'true';
  });
  return { attributes: { bounds: '[0,0][440,956]' }, children: [parent] };
}
function completedTrace() {
  return OBSERVATION_STAGES.map((stage) => ({
    stage,
    attemptId: 'one',
    interactionId: 'input-1',
    switchRowId: 'switch-1',
    componentId: 'parent-1',
    isOn: false,
    isPublic: false,
    capturedDisabled: false,
    capturedIsStartPending: false,
  }));
}

describe('finite session-input observation guards', () => {
  it('uses the CI point only when the freshly observed enabled ON thumb contains it', () => {
    const observed = inspectVisibility(observedHierarchy(), true);
    expect(observed.point).toEqual({ x: 369, y: 487 });
    expect(observed.pointSource).toBe('verified-ci-point');
    expect(inside(observed.thumbBounds, { x: 181, y: 466 })).toBe(false);
    expect(observed.hierarchy).not.toHaveProperty('children');
    expect(observed.screenBounds).toEqual({ left: 0, top: 0, right: 440, bottom: 956 });
  });
  it('derives a new safe point after a genuine layout move and rejects an unmatched thumb', () => {
    const tree = observedHierarchy();
    tree.children[0].attributes.bounds = '[32,556][407,618]';
    tree.children[0].children[2].attributes.bounds = '[346,573][409,601]';
    expect(inspectVisibility(tree, true).point).toEqual({ x: 369, y: 587 });
    tree.children[0].children[2].attributes.bounds = '[0,0][1,1]';
    expect(() => inspectVisibility(tree, true)).toThrow('tap_point_outside');
  });
  it('fails before input when the current control is OFF, disabled, ambiguous or malformed', () => {
    for (const change of [
      (tree: ReturnType<typeof observedHierarchy>) => {
        tree.children[0].attributes.checked = 'false';
      },
      (tree: ReturnType<typeof observedHierarchy>) => {
        tree.children[0].attributes.enabled = 'false';
      },
      (tree: ReturnType<typeof observedHierarchy>) => {
        tree.children.push(structuredClone(tree.children[0]));
      },
      (tree: ReturnType<typeof observedHierarchy>) => {
        tree.children[0].children = [];
      },
    ]) {
      const tree = observedHierarchy();
      change(tree);
      expect(() => inspectVisibility(tree, true)).toThrow();
    }
    expect(() => inspectVisibility(null, true)).toThrow();
  });
  it('builds exactly one point contact with retries disabled and immediate sensor hooks', () => {
    const flow = parse(singleTapFlow({ x: 369, y: 487 }).split('---\n')[1]) as Record<string, unknown>[];
    expect(flow).toHaveLength(3);
    expect(flow[1]).toEqual({ tapOn: { point: '369,487', repeat: 1, retryTapIfNoChange: false } });
    expect(JSON.stringify(flow)).not.toMatch(/Start|join|secondary|longPress/);
    expect(JSON.stringify(flow[0])).toContain('/before');
    expect(JSON.stringify(flow[2])).toContain('/after');
  });
  it('retains only generic trace stages, primitive diagnostic fields and safe IDs', () => {
    expect(
      redactedTrace(
        '[native-input] ' +
          JSON.stringify({
            stage: 'raw-wrapper',
            isOn: false,
            attemptId: '123-one',
            token: 'secret',
            headers: { authorization: 'secret' },
            email: 'private@example.com',
            variables: { password: 'secret' },
          }),
      ),
    ).toEqual({ stage: 'raw-wrapper', isOn: false, attemptId: '123-one' });
    expect(redactedTrace('[native-input] {"stage":"auth_response","token":"secret"}')).toBeNull();
    expect(redactedTrace('[native-input] broken')).toBeNull();
  });
  it('stops at the first missing hop and rejects foreign-instance or guarded commits', () => {
    const complete = completedTrace();
    expect(classifyAttempt(complete, true)).toEqual({ reproduced: false, boundary: 'none_observed' });
    expect(
      classifyAttempt(
        complete.filter((trace) => trace.stage !== 'after-haptic'),
        true,
      ).boundary,
    ).toBe('missing_after-haptic');
    expect(classifyAttempt([], false).boundary).toBe('before_raw_js_event');
    const foreign = completedTrace();
    foreign.at(-1)!.componentId = 'other-parent';
    expect(classifyAttempt(foreign, true).boundary).toBe('parent_instance_changed');
    const disabled = completedTrace();
    disabled[1].capturedDisabled = true;
    expect(classifyAttempt(disabled, true).boundary).toBe('captured_guard_not_false');
    expect(classifyAttempt(complete, false).reproduced).toBe(true);
  });
  it('permits only one fresh launch after the first completely observed successful input', () => {
    const success = {
      attempt: 1,
      reproduced: false,
      validTap: true,
      completeHooks: true,
      offConfirmed: true,
      commandStatus: 0,
    };
    expect(mayAttemptFreshLaunch(success)).toBe(true);
    for (const failure of [
      { attempt: 2 },
      { reproduced: true },
      { validTap: false },
      { completeHooks: false },
      { offConfirmed: false },
      { commandStatus: 1 },
    ])
      expect(mayAttemptFreshLaunch({ ...success, ...failure })).toBe(false);
  });
  it('allows live GraphQL reads and only exact existing-account auth routes', () => {
    expect(permitGraphqlRead({ query: 'query GetMyBoards { myBoards { __typename } }' })).toBe(true);
    expect(permitGraphqlRead({ query: 'subscription Watch { queue { __typename } }' })).toBe(true);
    expect(
      permitGraphqlRead([
        { query: '{ __typename }' },
        { query: 'mutation StartSession { startSession { __typename } }' },
      ]),
    ).toBe(false);
    expect(permitGraphqlRead({ query: 'mutation StartSession { startSession { __typename } }' })).toBe(false);
    expect(permitGraphqlRead({ query: 'query Safe { __typename } mutation Bad { x }', operationName: 'Safe' })).toBe(
      true,
    );
    expect(permitGraphqlRead({ query: 'query Safe { __typename } mutation Bad { x }' })).toBe(false);
    for (const path of ['/auth/native/credentials', '/auth/native/refresh', '/auth/native/revoke'])
      expect(observationHttpPolicy('POST', path, null)).toBe('auth');
    for (const path of [
      '/auth/native/register',
      '/auth/native/credentials/extra',
      '/auth/native/oauth',
      '/profile',
      '/graphql',
    ])
      expect(observationHttpPolicy('POST', path, { query: 'mutation Write { x }' })).toBe('blocked');
    expect(
      blockedOperationNames({ query: 'mutation StartSession($token:String){x}', variables: { token: 'secret' } }),
    ).toEqual(['StartSession']);
  });
  it('isolates hardlinked wrappers and rejects symlinks outside the owned checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), '7154-wrapper-'));
    try {
      const root = join(directory, 'owned');
      mkdirSync(root);
      const store = join(directory, 'store.js');
      writeFileSync(store, 'before');
      linkSync(store, join(root, 'wrapper.js'));
      expect(statSync(store).nlink).toBe(2);
      applyObservationWrapper(root, { 'wrapper.js': { before: 'before', after: 'observed' } });
      expect(readFileSync(store, 'utf8')).toBe('before');
      expect(readFileSync(join(root, 'wrapper.js'), 'utf8')).toBe('observed');
      expect(statSync(join(root, 'wrapper.js')).nlink).toBe(1);
      symlinkSync(store, join(root, 'foreign.js'));
      expect(() => applyObservationWrapper(root, { 'foreign.js': { before: 'before', after: 'bad' } })).toThrow(
        'preimage_mismatch',
      );
      expect(readFileSync(store, 'utf8')).toBe('before');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('isolates observation from native builds, normal capture, render and raw-log uploads', () => {
    const workflow = parse(readFileSync('.github/workflows/mobile-store-videos-measure.yml', 'utf8'));
    const evaluate = (expression: unknown, hit = false) =>
      runInNewContext(String(expression).replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
        inputs: { mode: 'observe-session-input' },
        steps: { 'app-cache': { outputs: { 'cache-hit': String(hit) } } },
        always: () => true,
      });
    expect(evaluate(workflow.jobs.record['timeout-minutes'])).toBe(30);
    const eligible = workflow.jobs.record.steps.filter((step: { if?: string }) => !step.if || evaluate(step.if));
    expect(eligible.some((step: { run?: string }) => step.run?.includes('mobile:build-sim-app'))).toBe(false);
    expect(eligible.some((step: { run?: string }) => step.run?.includes('video:record'))).toBe(false);
    expect(
      eligible
        .filter((step: { uses?: string }) => step.uses?.includes('upload-artifact'))
        .map((step: { with: { path: string } }) => step.with.path),
    ).toEqual(['.boardsesh/session-input-observation/public/']);
    expect(evaluate(workflow.jobs.render.if)).toBe(false);
    expect(evaluate(workflow.jobs.timings.if)).toBe(false);
    expect(
      eligible.find((step: { name?: string }) => step.name === 'Require the exact cached app for finite observation')
        .run,
    ).toContain('no build permitted');
  });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('live-read proxy enforcement on loopback', () => {
  it('forwards queries/auth but never forwards HTTP or WebSocket mutations', async () => {
    const httpRequests: { method: string | undefined; path: string | undefined }[] = [];
    const upstream = createServer((request, response) => {
      httpRequests.push({ method: request.method, path: request.url });
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end('{"data":{"__typename":"Query"}}');
    });
    const websocket = new WebSocketServer({ server: upstream });
    const remoteFrames: Record<string, unknown>[] = [];
    websocket.on('connection', (socket) =>
      socket.on('message', (bytes) => {
        const frame = JSON.parse(websocketText(bytes));
        remoteFrames.push(frame);
        if (frame.type === 'connection_init') socket.send('{"type":"connection_ack"}');
        if (frame.id === 'read') socket.send('{"id":"read","type":"next","payload":{"data":{"__typename":"Query"}}}');
      }),
    );
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    cleanup.push(async () => {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => upstream.close(() => resolve())));
    });
    const proxy = await startObservationProxy(() => ({}), {
      port: 0,
      upstream: `http://127.0.0.1:${port}`,
      websocketUpstream: `ws://127.0.0.1:${port}/graphql`,
    });
    cleanup.push(() => proxy.close());
    const endpoint = `http://127.0.0.1:${proxy.port}`;
    const post = (path: string, payload: unknown) =>
      fetch(endpoint + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    expect((await post('/graphql', { query: 'query Read { __typename }' })).status).toBe(200);
    expect(
      (await post('/auth/native/credentials', { email: 'fake@example.invalid', password: 'do-not-retain' })).status,
    ).toBe(200);
    expect(
      (await post('/graphql', { query: 'mutation StartSession { x }', variables: { token: 'do-not-retain' } })).status,
    ).toBe(403);
    expect((await post('/auth/native/register', { email: 'fake@example.invalid' })).status).toBe(403);
    expect(httpRequests.map((request) => request.path)).toEqual(['/graphql', '/auth/native/credentials']);
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/graphql`, 'graphql-transport-ws');
    cleanup.push(async () => {
      client.terminate();
    });
    const received: Record<string, unknown>[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('message', (bytes) => {
        const frame = JSON.parse(websocketText(bytes));
        received.push(frame);
        if (frame.type === 'connection_ack') {
          client.send(
            JSON.stringify({ id: 'read', type: 'subscribe', payload: { query: 'query Read { __typename }' } }),
          );
          client.send(
            JSON.stringify({
              id: 'write',
              type: 'subscribe',
              payload: { query: 'mutation JoinSession { x }', variables: { secret: 'do-not-retain' } },
            }),
          );
        }
        if (received.some((entry) => entry.id === 'read') && received.some((entry) => entry.id === 'write')) resolve();
      });
      client.once('open', () => client.send('{"type":"connection_init","payload":{"authorization":"do-not-retain"}}'));
    });
    await completed;
    expect(remoteFrames.some((frame) => frame.id === 'write')).toBe(false);
    expect(received.find((frame) => frame.id === 'write')?.type).toBe('error');
    expect(proxy.counters.blockedOperationNames).toEqual({ StartSession: 1, non_auth_http: 1, JoinSession: 1 });
    expect(JSON.stringify(proxy.counters)).not.toContain('do-not-retain');
  });
});
