import { describe, expect, it } from 'vitest';
import { createDiagnosticRecorder, DIAGNOSTIC_LIMITS } from '../mobile-diagnostics';
import { bootstrapDiagnosticLaunch, canAttributePreviousNativeCrash } from '../diagnostic-launch';
import { diagnosticGraphqlOperationName } from '../graphql/request-diagnostics';

describe('bounded operation diagnostics', () => {
  it('retains new phase and failure evidence when the attribute budget is full', () => {
    const recorder = createDiagnosticRecorder();
    const operation = recorder.begin('ble', 'connect', {
      attributes: {
        source: 'lightbulb',
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        angle: 40,
        climbUuid: 'climb',
        sessionId: 'session',
        attempt: 1,
        permission: 'granted',
        adapter: 'on',
        scanFamily: 'aurora',
        targeted: true,
      },
    });
    operation.step('write', { writeType: 'with-response', attempt: 2, token: 'secret' });
    expect(recorder.snapshot().active[0].attributes).toMatchObject({ writeType: 'with-response', attempt: 2 });
    operation.finish('failure', { failureCategory: 'native', errorCode: 'write-failed', packet: 'private' });
    const snapshot = recorder.snapshot();
    expect(snapshot.completed.ble?.attributes).toMatchObject({ failureCategory: 'native', errorCode: 'write-failed' });
    expect(Object.keys(snapshot.completed.ble!.attributes)).toHaveLength(12);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private/);
  });

  it('keeps simultaneous flows and ignores stale completion and callbacks', () => {
    let timestamp = 100;
    let sequence = 0;
    const recorder = createDiagnosticRecorder({ now: () => timestamp, makeId: () => `op-${++sequence}` });
    const old = recorder.begin('ble', 'connect', { userInitiated: true });
    const auth = recorder.begin('auth', 'refresh');
    const latest = recorder.begin('ble', 'send', { parentId: old.id, userInitiated: true });
    timestamp = 150;
    latest.finish('success');
    old.finish('failure');
    latest.step('late');
    latest.finish('failure');
    expect(recorder.snapshot().completed.ble).toMatchObject({ id: latest.id, outcome: 'success', durationMs: 50 });
    expect(recorder.snapshot().active.map((operation) => operation.id)).toEqual([auth.id]);
    expect(recorder.feedback().lastUserOperationId).toBe(latest.id);
    expect(recorder.snapshot().breadcrumbs.find((crumb) => crumb.data.operationId === latest.id)?.data.parentId).toBe(
      old.id,
    );
  });

  it('bounds active operations without evicting them or allowing overflow completion', () => {
    const recorder = createDiagnosticRecorder();
    const active = Array.from({ length: 16 }, () => recorder.begin('data', 'fetch'));
    const overflow = recorder.begin('data', 'overflow');
    overflow.finish('success');
    expect(recorder.snapshot()).toMatchObject({ overflowCount: 1 });
    expect(recorder.snapshot().active).toHaveLength(16);
    active[15].finish('success');
    expect(recorder.snapshot().completed.data?.id).toBe(active[15].id);
  });

  it('removes sensitive attributes, bounds UTF-8 context, and returns independent copies', () => {
    const recorder = createDiagnosticRecorder();
    recorder.initialize({ launchId: '😀'.repeat(10000), otaBranch: 'x'.repeat(10000) });
    for (let index = 0; index < 250; index += 1) {
      const operation = recorder.begin('data', 'sync', {
        attributes: {
          source: '😀'.repeat(128),
          route: '😀'.repeat(128),
          table: '😀'.repeat(128),
          downloadScope: '😀'.repeat(128),
          operationName: '😀'.repeat(128),
          password: 'secret',
          token: 'secret',
          packet: 'private',
          variables: 'private',
        },
      });
      operation.finish('success');
    }
    const snapshot = recorder.snapshot();
    expect(snapshot.breadcrumbs.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.breadcrumbs);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(
      DIAGNOSTIC_LIMITS.contextBytes,
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private/);
    snapshot.completed.data!.attributes.source = 'changed';
    expect(recorder.snapshot().completed.data?.attributes.source).not.toBe('changed');
  });

  it('survives failed telemetry integrations and resets across JS runtimes', () => {
    const recorder = createDiagnosticRecorder({
      sink: () => {
        throw new Error('SDK unavailable');
      },
    });
    recorder.initialize({ launchId: 'runtime-one' });
    recorder.setIdentityReader(() => {
      throw new Error('replay unavailable');
    });
    expect(() => recorder.begin('navigation', 'route').finish('success')).not.toThrow();
    expect(recorder.feedback().launchId).toBe('runtime-one');
    expect(createDiagnosticRecorder().snapshot().active).toEqual([]);
    expect(createDiagnosticRecorder().feedback().launchId).toBeUndefined();
  });
});

describe('launch correlation', () => {
  it('persists only IDs and links an earlier runtime without treating an OTA reload as a crash', () => {
    let written = '';
    const previous = JSON.stringify({ launchId: 'previous', nativeStartupId: 'process-one' });
    const launch = bootstrapDiagnosticLaunch({
      readPrevious: () => previous,
      writeCurrent: (serialized) => {
        written = serialized;
      },
      makeId: () => 'current',
      metadata: { nativeStartupId: 'process-one', otaUpdateId: 'ota-current' },
    });
    expect(launch).toMatchObject({ launchId: 'current', previousLaunchId: 'previous' });
    expect(JSON.parse(written)).toEqual({ launchId: 'current', nativeStartupId: 'process-one' });
    expect(canAttributePreviousNativeCrash(previous, 'process-one', 'process-one')).toBe(false);
    expect(canAttributePreviousNativeCrash(previous, 'process-two', 'process-one')).toBe(true);
    // A process crashing before JS never persisted a runtime. SDK true refers
    // to that process, not the older runtime still stored by SecureStore.
    expect(canAttributePreviousNativeCrash(previous, 'process-three', 'process-two')).toBe(false);
    expect(canAttributePreviousNativeCrash(previous, 'process-two', undefined)).toBe(false);
    expect(canAttributePreviousNativeCrash('{"launchId":"legacy"}', 'process-two', 'process-one')).toBe(false);
  });

  it('survives unavailable storage and rejects corrupt prior IDs', () => {
    const launch = bootstrapDiagnosticLaunch({
      readPrevious: () => {
        throw new Error('locked');
      },
      writeCurrent: () => {
        throw new Error('locked');
      },
      makeId: () => 'current',
      metadata: {},
    });
    expect(launch.previousLaunchId).toBeNull();
    expect(canAttributePreviousNativeCrash('invalid', 'current', 'previous')).toBe(false);
    expect(canAttributePreviousNativeCrash('x'.repeat(5000), 'current', 'previous')).toBe(false);
  });
});

it('extracts request operation names without leaking variables, query bodies or malformed input', () => {
  expect(
    diagnosticGraphqlOperationName(
      JSON.stringify({
        query: 'mutation SubmitFeedback($password: String) { submit }',
        variables: { password: 'secret' },
      }),
    ),
  ).toBe('SubmitFeedback');
  expect(
    diagnosticGraphqlOperationName(
      JSON.stringify({ operationName: 'secret@example.com', query: '{ user { email } }' }),
    ),
  ).toBe('graphql.request');
  expect(diagnosticGraphqlOperationName('invalid')).toBe('graphql.request');
  expect(diagnosticGraphqlOperationName('x'.repeat(256001))).toBe('graphql.request');
});
