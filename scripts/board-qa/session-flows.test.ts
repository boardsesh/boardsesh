import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IosDriver, readFlow } from './drivers';
import { Evidence } from './evidence';
import { selectorPredicate } from '../lib/mobile-profile-wda';

const sessionId = '11111111-2222-4333-8444-555555555555';
const variables = {
  APP_ID: 'com.boardsesh.app',
  RECORD_URL: 'com.boardsesh.app://record',
  SESSION_URL: `com.boardsesh.app://join/${sessionId}`,
  SESSION_ID: sessionId,
  EXPECTED_ROSTER_COUNT: '2',
  USER_ID: 'qa-user',
  SESSION_EXIT_LABEL: 'End session',
  SESSION_SUMMARY_LABEL: 'Session Summary',
};
const flow = (name: string) => readFlow(resolve(`packages/mobile/.maestro/board-qa/${name}.yaml`), variables);
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('visible session leaf flow contracts', () => {
  it('starts with the real Start control and waits for the visible one-climber session leaf', () => {
    const commands = flow('start-session');
    expect(commands).toContainEqual({ tapOn: { id: 'session-start' } });
    expect(commands.at(-1)).toEqual({
      extendedWaitUntil: { visible: { id: 'session-presence-[0-9a-fA-F-]{36}-1' }, timeout: 30000 },
    });
  });
  it('requires the exact invited session and two-climber count after the real Join confirmation', () => {
    const commands = flow('join-session');
    expect(commands).toContainEqual({ tapOn: { id: 'session-join-confirm' } });
    expect(commands.at(-1)).toEqual({
      extendedWaitUntil: { visible: { id: `session-presence-${sessionId}-2` }, timeout: 30000 },
    });
  });
  it('binds the visible roster count to the exact session while retaining the native user identity/state check', () => {
    expect(flow('open-roster')).toEqual([
      { openLink: variables.RECORD_URL },
      { extendedWaitUntil: { visible: { id: `session-presence-${sessionId}-2` }, timeout: 30000 } },
      { assertVisible: { id: 'session-user-qa-user-CONNECTED' } },
    ]);
    const exact = new RegExp(`^session-presence-${sessionId}-2$`);
    expect(exact.test(`session-presence-${sessionId}-1`)).toBe(false);
    expect(exact.test('session-presence-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-2')).toBe(false);
  });
  it.each(['leave-session', 'end-session'])('keeps the %s visible binding and real exit controls', (name) => {
    const commands = flow(name);
    expect(commands[1]).toEqual({
      extendedWaitUntil: { visible: { id: `session-presence-${sessionId}-[1-9][0-9]*` }, timeout: 30000 },
    });
    expect(commands[2]).toEqual({ tapOn: variables.SESSION_EXIT_LABEL });
    expect(commands).toContainEqual({ tapOn: { id: 'sheet-top-bar-trailing' } });
    expect(commands.at(-1)).toEqual({ extendedWaitUntil: { visible: { id: 'session-start' }, timeout: 30000 } });
    if (name === 'end-session')
      expect(commands).toContainEqual({
        extendedWaitUntil: { notVisible: { id: `session-presence-${sessionId}-[1-9][0-9]*` }, timeout: 30000 },
      });
  });
  it('keeps the global native visibility predicate and never asks metadata containers to prove visible session UI', () => {
    for (const name of ['start-session', 'join-session', 'open-roster', 'leave-session', 'end-session']) {
      const serialized = JSON.stringify(flow(name));
      expect(serialized).not.toContain('session-active-');
      expect(serialized).not.toContain('session-roster-');
      expect(serialized).toContain('session-presence-');
    }
    expect(selectorPredicate({ id: `session-presence-${sessionId}-2` })).toContain('visible == 1');
  });
  it('requires the expected creator summary before Close and Record navigation, while Leave expects no summary', () => {
    const ended = flow('end-session');
    expect(ended.slice(-5)).toEqual([
      { extendedWaitUntil: { visible: 'Session Summary', timeout: 30000 } },
      { tapOn: { id: 'header-leading-action' } },
      { extendedWaitUntil: { notVisible: 'Session Summary', timeout: 30000 } },
      { openLink: variables.RECORD_URL },
      { extendedWaitUntil: { visible: { id: 'session-start' }, timeout: 30000 } },
    ]);
    expect(ended.some((command) => 'runFlow' in command)).toBe(false);
    expect(flow('leave-session').some((command) => 'runFlow' in command)).toBe(false);
    expect(JSON.stringify(flow('leave-session'))).not.toContain('header-leading-action');
  });
  it.each([0, 1000, null])(
    'waits for the expected summary and fails closed if it never appears (delay=%s)',
    async (summaryDelayMs) => {
      vi.useFakeTimers();
      const directory = mkdtempSync(join(tmpdir(), 'board-qa-exit-flow-'));
      directories.push(directory);
      const evidence = new Evidence(directory);
      const driver = new IosDriver(
        {
          id: '00008110-0000000000000001',
          appId: variables.APP_ID,
          scheme: 'com.boardsesh.app',
          email: 'qa@example.com',
          labels: { SESSION_SUMMARY_LABEL: 'Résumé de la séance' },
          wdaUrl: 'http://127.0.0.1:8211',
        },
        evidence,
      );
      driver['session'] = 'exit-flow-test';
      let active = true,
        confirmation = false,
        summary = false,
        closed = false;
      const clicked: string[] = [];
      const queries: string[] = [];
      const timeline: string[] = [];
      const selectors = new Map([
        [selectorPredicate({ id: `session-presence-${sessionId}-[1-9][0-9]*` }), 'active'],
        [selectorPredicate(variables.SESSION_EXIT_LABEL), 'end'],
        [selectorPredicate({ id: 'session-exit-sheet-end' }), 'confirmation'],
        [selectorPredicate({ id: 'sheet-top-bar-trailing' }), 'confirm'],
        [selectorPredicate('Résumé de la séance'), 'summary'],
        [selectorPredicate({ id: 'header-leading-action' }), 'close'],
        [selectorPredicate({ id: 'session-start' }), 'start'],
      ]);
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
          if (url.pathname.endsWith('/url')) {
            if (!active && !closed) throw new Error('Record navigation occurred before the expected summary closed');
            timeline.push('record');
            return Response.json({ value: null });
          }
          if (url.pathname.endsWith('/elements')) {
            if (typeof init?.body !== 'string') throw new Error('Expected literal selector JSON');
            const predicate = (JSON.parse(init.body) as { value: string }).value;
            const control = selectors.get(predicate);
            if (!control) throw new Error('Unexpected native selector');
            queries.push(control);
            if (control === 'close' && !summary) throw new Error('Close was queried before the summary appeared');
            const visible =
              control === 'active' || control === 'end'
                ? active
                : control === 'confirmation' || control === 'confirm'
                  ? confirmation
                  : control === 'summary' || control === 'close'
                    ? summary
                    : !active && !summary;
            return Response.json({ value: visible ? [{ ELEMENT: control }] : [] });
          }
          const control = url.pathname.match(/\/element\/([^/]+)\/click$/)?.[1];
          if (!control) throw new Error('Unexpected native route');
          clicked.push(control);
          timeline.push(`click:${control}`);
          if (control === 'end') confirmation = true;
          else if (control === 'confirm') {
            active = false;
            confirmation = false;
            if (summaryDelayMs !== null)
              setTimeout(() => {
                summary = true;
                timeline.push('summary-appeared');
              }, summaryDelayMs);
          } else if (control === 'close') {
            if (!summary) throw new Error('Summary close ran before the summary appeared');
            summary = false;
            closed = true;
          } else throw new Error('Unexpected native mutation');
          return Response.json({ value: null });
        }),
      );
      const localeVariables = Object.fromEntries(
        Object.entries(variables).filter(([key]) => key !== 'SESSION_SUMMARY_LABEL'),
      );
      const completed = driver.flow('end-session', localeVariables).catch((error: unknown) => error);
      if (summaryDelayMs === 1000) {
        await vi.advanceTimersByTimeAsync(999);
        expect(queries.filter((query) => query === 'summary').length).toBeGreaterThan(1);
        expect(clicked).toEqual(['end', 'confirm']);
        expect(timeline.filter((step) => step === 'record')).toHaveLength(1);
        expect(queries).not.toContain('start');
      }
      await vi.advanceTimersByTimeAsync(30000);
      if (summaryDelayMs === null) {
        expect(await completed).toMatchObject({
          kind: 'failed',
          message: 'Deadline exceeded: iPhone extendedWaitUntil',
        });
        expect(clicked).toEqual(['end', 'confirm']);
        expect(queries).not.toContain('close');
        expect(queries).not.toContain('start');
        expect(timeline.filter((step) => step === 'record')).toHaveLength(1);
      } else {
        expect(await completed).toBeUndefined();
        expect(clicked).toEqual(['end', 'confirm', 'close']);
        expect(queries.at(-1)).toBe('start');
        expect(timeline).toEqual(['record', 'click:end', 'click:confirm', 'summary-appeared', 'click:close', 'record']);
      }
      expect(active).toBe(false);
      expect(summary).toBe(false);
    },
  );
});
