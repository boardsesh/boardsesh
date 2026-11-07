import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { IosDriver } from './drivers';
import { Evidence } from './evidence';
import { selectorPredicate, swipeActions } from '../lib/mobile-profile-wda';

const directories: string[] = [];
function driver(): IosDriver {
  const directory = mkdtempSync(join(tmpdir(), 'board-qa-driving-flow-'));
  directories.push(directory);
  const phone = new IosDriver(
    {
      id: 'owned',
      appId: 'com.boardsesh.app',
      scheme: 'com.boardsesh.app',
      email: 'qa@example.com',
      wdaUrl: 'http://127.0.0.1:8211',
    },
    new Evidence(directory),
  );
  phone['session'] = 'drive-flow-test';
  return phone;
}
afterEach(() => {
  vi.unstubAllGlobals();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

it.each(['idle', 'timed', 'open-ended'] as const)(
  'normalizes the visible %s player to a fresh open-ended drive despite a hidden older driving player',
  async (initial) => {
    const phone = driver();
    let visibleState: 'idle' | 'driving' = initial === 'idle' ? 'idle' : 'driving';
    let sheetVisible = false;
    const actions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith('/elements')) {
          if (typeof init?.body !== 'string') throw new Error('Expected selector JSON');
          const predicate = (JSON.parse(init.body) as { value: string }).value;
          const selectors = new Map([
            [selectorPredicate({ id: 'busy-wall-question' }), { present: false, element: 'busy' }],
            // Retained older driving routes exist, but these native selectors
            // require visible == 1 and only return the current player.
            [
              selectorPredicate({ id: 'wall-control-.*-self-driving' }),
              { present: visibleState === 'driving', element: 'driving' },
            ],
            [
              selectorPredicate({ id: 'wall-control-.*-self-idle' }),
              { present: visibleState === 'idle', element: 'idle' },
            ],
            [selectorPredicate({ id: 'play-drawer-wall-control' }), { present: !sheetVisible, element: 'wall' }],
            [
              selectorPredicate({ id: 'ble-control-drive' }),
              { present: sheetVisible && visibleState === 'idle', element: 'drive' },
            ],
          ]);
          const selector = selectors.get(predicate);
          if (!selector) throw new Error('Unexpected selector');
          expect(predicate).toContain('visible == 1');
          return Response.json({ value: selector.present ? [{ ELEMENT: selector.element }] : [] });
        }
        if (url.pathname.endsWith('/element/wall/click')) {
          expect(visibleState).toBe('driving');
          visibleState = 'idle';
          actions.push('stop-visible-drive');
          return Response.json({ value: null });
        }
        if (url.pathname.endsWith('/element/wall/rect'))
          return Response.json({ value: { x: 16, y: 722, width: 358, height: 45 } });
        if (url.pathname.endsWith('/actions')) {
          expect(visibleState).toBe('idle');
          sheetVisible = true;
          actions.push('open-board-controls');
          return Response.json({ value: null });
        }
        if (url.pathname.endsWith('/element/drive/click')) {
          expect(sheetVisible).toBe(true);
          visibleState = 'driving';
          sheetVisible = false;
          actions.push('start-open-ended-drive');
          return Response.json({ value: null });
        }
        throw new Error('Unexpected native action');
      }),
    );
    await phone.flow('drive');
    expect(actions).toEqual([
      ...(initial === 'idle' ? [] : ['stop-visible-drive']),
      'open-board-controls',
      'start-open-ended-drive',
    ]);
    expect(visibleState).toBe('driving');
  },
);

it('takes one actual board swipe when the optional Next button is absent', async () => {
  const phone = driver();
  const actions: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/elements')) {
        if (typeof init?.body !== 'string') throw new Error('Expected selector JSON');
        const predicate = (JSON.parse(init.body) as { value: string }).value;
        expect([
          selectorPredicate({ id: 'play-drawer-board-accessibility' }),
          selectorPredicate({ id: 'wall-control-.*-self-driving' }),
        ]).toContain(predicate);
        return Response.json({ value: [{ ELEMENT: 'visible-current-player' }] });
      }
      if (url.pathname.endsWith('/window/size')) return Response.json({ value: { width: 400, height: 900 } });
      if (url.pathname.endsWith('/actions')) {
        if (typeof init?.body !== 'string') throw new Error('Expected gesture JSON');
        actions.push(JSON.parse(init.body));
        return Response.json({ value: null });
      }
      throw new Error('Unexpected native action');
    }),
  );
  await phone.flow('next');
  expect(actions).toEqual([swipeActions({ x: 320, y: 405 }, { x: 80, y: 405 }, 400)]);
});
