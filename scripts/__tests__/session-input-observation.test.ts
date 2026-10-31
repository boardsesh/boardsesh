import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';
import {
  classifyAttempt,
  hierarchyNode,
  inside,
  inspectVisibility,
  mayAttemptFreshLaunch,
  OBSERVATION_STAGES,
  redactedTrace,
  singleTapFlow,
} from '../lib/session-input-observation/guards';
import { applyObservationWrapper } from '../lib/session-input-observation/wrapper';
import {
  assertObservationFixture,
  OBSERVATION_FIXTURE,
  observationReplayOptions,
  replayOperationCounter,
} from '../lib/session-input-observation/replay';
import { createScreenshotBackend } from '../lib/screenshot-backend';
import { emptyManifest } from '../lib/screenshot-fixtures';

const fixture = JSON.parse(
  readFileSync('scripts/__tests__/fixtures/showcase-session-visibility/ios-maestro-2.6.1.json', 'utf8'),
) as { hierarchy: unknown };
function observedHierarchy() {
  const parent = hierarchyNode(structuredClone(fixture.hierarchy));
  parent.attributes = { ...parent.attributes, enabled: 'true', value: '1' };
  parent.children.forEach((child) => {
    child.attributes.enabled = 'true';
  });
  return { attributes: { accessibilityText: 'Boardsesh', bounds: '[0,0][440,956]' }, children: [parent] };
}
function completedTrace() {
  return OBSERVATION_STAGES.map((stage) => ({
    stage,
    attemptId: 'one',
    interactionId: 'input-1',
    switchRowId: 'switch-1',
    componentId: stage === 'switch-row-props-committed' ? 'switch-1' : 'parent-1',
    value: false,
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
    expect(JSON.stringify(flow[0])).toContain('127.0.0.1:8120/__observation/before');
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
  it('rejects target unmount/remount and replacement-row commits even when parent and inherited interaction tags match', () => {
    const rowReplaced = completedTrace();
    rowReplaced.find((trace) => trace.stage === 'switch-row-props-committed')!.componentId = 'replacement-row';
    expect(classifyAttempt(rowReplaced, true).boundary).toBe('row_commit_instance_changed');
    const stillOn = completedTrace();
    stillOn.find((trace) => trace.stage === 'switch-row-props-committed')!.value = true;
    expect(classifyAttempt(stillOn, true).boundary).toBe('target_row_not_committed_off');
    for (const lifecycle of ['switch-row-unmounted', 'switch-row-mounted']) {
      const trace: Record<string, unknown>[] = completedTrace();
      trace.push({ ...trace[0], stage: lifecycle, componentId: 'switch-1' });
      expect(classifyAttempt(trace, true).reproduced).toBe(true);
    }
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
  it('pins the exact local-baseline replay snapshot and never configures a live upstream', () => {
    expect(OBSERVATION_FIXTURE).toMatchObject({
      sha256: '03ddb626f41d3627f587f3bff1686e2d0cc098630973d14a730f348dfe546ed1',
      bytes: 1663568,
      files: 346,
    });
    expect(() => assertObservationFixture(OBSERVATION_FIXTURE)).not.toThrow();
    expect(() => assertObservationFixture({ ...OBSERVATION_FIXTURE, sha256: '0'.repeat(64) })).toThrow('pin_changed');
    expect(() => assertObservationFixture({ ...OBSERVATION_FIXTURE, bytes: OBSERVATION_FIXTURE.bytes + 1 })).toThrow(
      'pin_changed',
    );
    expect(observationReplayOptions('/owned/fixtures', '2026-09-19T14:39:54Z', () => {})).toMatchObject({
      mode: 'replay',
      upstreamUrl: null,
    });
    const retained = replayOperationCounter(
      '[screenshot-backend] MISS graphql GetProfile abcd variables={"email":"private@example.invalid","token":"secret"}',
    );
    expect(retained).toEqual({ outcome: 'MISS', operationName: 'GetProfile' });
    expect(replayOperationCounter('[screenshot-backend] HIT auth email=private@example.invalid')).toBeNull();
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
    expect(
      workflow.jobs.record.steps.find((step: { uses?: string }) => step.uses === 'actions/checkout@v4').with[
        'fetch-depth'
      ],
    ).toBe(0);
    expect(evaluate(workflow.jobs.record['timeout-minutes'])).toBe(30);
    const eligible = workflow.jobs.record.steps.filter((step: { if?: string }) => !step.if || evaluate(step.if));
    expect(eligible.some((step: { run?: string }) => step.run?.includes('mobile:build-sim-app'))).toBe(false);
    expect(eligible.some((step: { run?: string }) => step.run?.includes('video:record'))).toBe(false);
    expect(
      eligible
        .filter((step: { uses?: string }) => step.uses?.includes('upload-artifact'))
        .map((step: { with: { path: string } }) => step.with.path),
    ).toEqual(['.boardsesh/session-input-observation/public/']);
    const observation = eligible.find((step: { run?: string }) =>
      step.run?.includes('scripts/observe-session-input.ts'),
    );
    expect(JSON.stringify(observation.env)).not.toMatch(/secrets|SCREENSHOT_USER/);
    const harness = readFileSync('scripts/observe-session-input.ts', 'utf8');
    expect(harness).not.toMatch(/startObservationProxy|process\.env\.SCREENSHOT_USER|ws\.boardsesh\.com/);
    expect(harness).toContain('startPinnedObservationReplay');
    expect(harness).toContain('EXPO_PUBLIC_SCREENSHOT_NOW: replay.frozenNow');
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
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('fixture-only backend observation', () => {
  it('keeps auth, unsafe query names, WS subscriptions, static misses and unknown routes local', async () => {
    const directory = mkdtempSync(join(tmpdir(), '7154-replay-'));
    cleanup.push(async () => {
      rmSync(directory, { recursive: true, force: true });
    });
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify(
        emptyManifest({
          recordedAt: '2026-09-19T14:39:54Z',
          frozenNow: '2026-09-19T14:39:54Z',
          upstream: 'https://example.invalid',
          accountEmail: 'test@boardsesh.com',
          accountUserId: '11111111-2222-3333-4444-555555555555',
          flow: 'app-store',
        }),
      ),
    );
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_outbound'));
    const backend = createScreenshotBackend(observationReplayOptions(directory, '2026-09-19T14:39:54Z', () => {}));
    cleanup.push(() => backend.close());
    const port = await backend.listen(0, '127.0.0.1');
    const send = (path: string, method = 'GET', payload?: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${port}${path}`,
          { method, headers: { 'content-type': 'application/json' } },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        request.on('error', reject);
        request.end(payload ? JSON.stringify(payload) : undefined);
      });
    expect(
      (await send('/auth/native/credentials', 'POST', { email: 'test@boardsesh.com', password: 'test' })).status,
    ).toBe(200);
    const unsafeNamedQuery = await send('/graphql', 'POST', {
      query: 'query BetaLinks { betaLinks { __typename } }',
      operationName: 'BetaLinks',
    });
    expect(unsafeNamedQuery.status).toBe(200);
    expect(unsafeNamedQuery.body).toContain('fixture miss');
    expect((await send('/static/not-recorded.png')).status).toBe(404);
    expect((await send('/unknown')).status).toBe(404);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    cleanup.push(async () => {
      socket.terminate();
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', (bytes) => {
        const frame = JSON.parse(
          Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes as ArrayBuffer).toString('utf8'),
        );
        if (frame.type === 'connection_ack')
          socket.send(
            JSON.stringify({
              id: 'controller',
              type: 'subscribe',
              payload: {
                query: 'subscription ControllerEvents { controllerEvents { __typename } }',
                operationName: 'ControllerEvents',
              },
            }),
          );
        if (frame.id === 'controller') resolve();
      });
      socket.once('open', () => socket.send('{"type":"connection_init","payload":{}}'));
    });
    expect(outbound).not.toHaveBeenCalled();
    expect(backend.stats().recorded).toBe(0);
    expect(() =>
      createScreenshotBackend({
        ...observationReplayOptions(directory, '2026-09-19T14:39:54Z', () => {}),
        upstreamUrl: 'https://example.invalid',
      }),
    ).toThrow('no outbound requests');
  });
});
