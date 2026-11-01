import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { command } from './drivers';
import { Evidence } from './evidence';
import { notificationPrevious } from './notifications';

vi.mock('./drivers', () => ({ command: vi.fn() }));
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
function evidence(): Evidence {
  const directory = mkdtempSync(join(tmpdir(), 'board-qa-notifications-'));
  directories.push(directory);
  return new Evidence(directory);
}
it('classifies a missing unique notification as blocked and collapses without Back', async () => {
  vi.useFakeTimers();
  vi.mocked(command).mockResolvedValue('ERROR: null root node');
  const completed = notificationPrevious('adb', 'owned', 'DUNES', evidence()).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await completed).toMatchObject({ kind: 'blocked', message: 'No unique Boardsesh notification action' });
  expect(command).toHaveBeenLastCalledWith('adb', ['-s', 'owned', 'shell', 'cmd', 'statusbar', 'collapse']);
  expect(vi.mocked(command).mock.calls.some(([, args]) => args.includes('KEYCODE_BACK'))).toBe(false);
});
it('retries a malformed dump and taps only the later valid scoped notification', async () => {
  vi.useFakeTimers();
  let dumps = 0;
  vi.mocked(command).mockImplementation(async (_adb, args) => {
    if (!args.includes('dump')) return '';
    if (++dumps === 1) return '<hierarchy><node></hierarchy>';
    return '<hierarchy><node resource-id="com.android.systemui:id/status_bar_latest_event_content"><node text="Boardsesh"/><node text="DUNES"/><node text="Previous" enabled="true" clickable="true" bounds="[10,20][50,60]"/></node></hierarchy>';
  });
  const completed = notificationPrevious('adb', 'owned', 'DUNES', evidence());
  await vi.advanceTimersByTimeAsync(250);
  await completed;
  expect(dumps).toBe(2);
  expect(command).toHaveBeenCalledWith('adb', ['-s', 'owned', 'shell', 'input', 'tap', '30', '40']);
});
