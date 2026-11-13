import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AndroidDriver, IosDriver, readFlow } from './drivers';
import { Evidence } from './evidence';
import { selectorPredicate } from '../lib/mobile-profile-wda';

const directories: string[] = [];
const currentHeader = { id: 'play-drawer-header-accessibility', text: '.*Moon Landing.*' };
const playerHeader = { id: 'play-drawer-header-accessibility' };
const variables = { CURRENT_CLIMB_LABEL_PATTERN: currentHeader.text };
const phone = {
  id: 'owned',
  appId: 'com.boardsesh.app',
  scheme: 'com.boardsesh.app',
  email: 'qa@example.com',
  wdaUrl: 'http://127.0.0.1:8211',
};
function evidence(): Evidence {
  const directory = mkdtempSync(join(tmpdir(), 'board-qa-return-current-'));
  directories.push(directory);
  return new Evidence(directory);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

it.each([true, false])(
  'reopens committed current independently of the last-look mini-player, only after preview unmounts (closes=%s)',
  async (closes) => {
    vi.useFakeTimers();
    const driver = new IosDriver(phone, evidence());
    driver['session'] = 'return-current-test';
    let player: 'preview' | 'closed' | 'committed' = 'preview';
    // Closing a preview preserves the mini-player's last look. It is not the
    // committed queue slot and must not be used to find that slot again.
    const miniPlayerClimb = 'Angel Eyes';
    const actions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith('/elements')) {
          if (typeof init?.body !== 'string') throw new Error('Expected selector JSON');
          const predicate = (JSON.parse(init.body) as { value: string }).value;
          if (predicate === selectorPredicate({ id: 'play-drawer-close' }))
            return Response.json({ value: player === 'preview' ? [{ ELEMENT: 'close' }] : [] });
          if (predicate === selectorPredicate(playerHeader))
            return Response.json({ value: player === 'closed' ? [] : [{ ELEMENT: 'header' }] });
          if (predicate === selectorPredicate(currentHeader))
            return Response.json({ value: player === 'committed' ? [{ ELEMENT: 'current' }] : [] });
          throw new Error('The last-look mini-player cannot identify the committed queue slot');
        }
        if (url.pathname.endsWith('/element/close/click')) {
          actions.push('close-preview');
          if (closes) player = 'closed';
          return Response.json({ value: null });
        }
        if (url.pathname.endsWith('/url')) {
          expect(player).toBe('closed');
          if (typeof init?.body !== 'string') throw new Error('Expected player-link JSON');
          expect(JSON.parse(init.body)).toEqual({ url: 'com.boardsesh.app://play', bundleId: phone.appId });
          actions.push('open-committed-player');
          player = 'committed';
          return Response.json({ value: null });
        }
        throw new Error('Unexpected native action');
      }),
    );
    const completed = driver.flow('return-current', variables).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    if (closes) {
      expect(await completed).toBeUndefined();
      expect(actions).toEqual(['close-preview', 'open-committed-player']);
      expect(player).toBe('committed');
    } else {
      expect(await completed).toMatchObject({ kind: 'failed', message: 'Deadline exceeded: iPhone extendedWaitUntil' });
      expect(actions).toEqual(['close-preview']);
    }
    expect(miniPlayerClimb).toBe('Angel Eyes');
  },
);

it('keeps the Android close/unmount gate before the package-targeted committed-player link and exact header check', async () => {
  let player: 'preview' | 'closed' | 'committed' = 'preview';
  const actions: string[] = [];
  const run = vi.fn(async (executable: string, args: string[]) => {
    if (executable === '/qa/adb') {
      expect(player).toBe('closed');
      expect(args).toEqual([
        '-s',
        phone.id,
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        "'com.boardsesh.app://play'",
        '-p',
        "'com.boardsesh.app'",
      ]);
      actions.push('open-committed-player');
      player = 'committed';
      return 'Status: ok';
    }
    const commands = readFlow(resolve(args.at(-1)!), { APP_ID: phone.appId });
    if (player === 'preview') {
      expect(commands).toEqual([
        { tapOn: { id: 'play-drawer-close' } },
        { extendedWaitUntil: { notVisible: playerHeader, timeout: 10000 } },
      ]);
      actions.push('close-and-wait-for-unmount');
      player = 'closed';
    } else {
      expect(player).toBe('committed');
      expect(commands).toEqual([{ extendedWaitUntil: { visible: currentHeader, timeout: 15000 } }]);
      actions.push('verify-exact-current');
    }
    return '';
  });
  await new AndroidDriver(phone, '/qa/adb', evidence(), run).flow('return-current', variables);
  expect(actions).toEqual(['close-and-wait-for-unmount', 'open-committed-player', 'verify-exact-current']);
});
