import { describe, expect, it, vi } from 'vitest';
import { makeAutoOfflineBoardsToggle, type AutoOfflineBoardsToggleDeps } from '../auto-offline-boards-toggle';

function makeDeps(overrides: Partial<AutoOfflineBoardsToggleDeps> = {}) {
  const calls: string[] = [];
  const deps = {
    downloadingMessage: (boardCount: number) => `downloading ${boardCount}`,
    setAutoOfflineBoards: vi.fn((enabled: boolean) => calls.push(`set:${enabled}`)),
    missingBoardCount: vi.fn(() => 3),
    rememberDownloadAllTap: vi.fn(() => calls.push('remember')),
    forgetDownloadAllTap: vi.fn(() => calls.push('forget')),
    trackDownloadAllTapped: vi.fn(() => calls.push('track')),
    isOfflineEngineEnabled: vi.fn(() => true),
    showToast: vi.fn(() => calls.push('toast')),
    ...overrides,
  } satisfies AutoOfflineBoardsToggleDeps;
  return { deps, calls };
}

describe('makeAutoOfflineBoardsToggle — switching on', () => {
  it('persists the switch, remembers the tap, then tracks it and says how many boards will download', () => {
    const { deps, calls } = makeDeps();
    makeAutoOfflineBoardsToggle(deps)(true);
    expect(deps.setAutoOfflineBoards).toHaveBeenCalledWith(true);
    // Remembered before the event, so the download effect that runs next can
    // already claim the tap.
    expect(calls).toEqual(['set:true', 'remember', 'track', 'toast']);
    expect(deps.forgetDownloadAllTap).not.toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith('downloading 3');
  });

  it('tracks OfflineDownloadAllTapped once per tap, with the board count and the engine flag', () => {
    const { deps } = makeDeps({ missingBoardCount: () => 5, isOfflineEngineEnabled: () => false });
    makeAutoOfflineBoardsToggle(deps)(true);
    expect(deps.trackDownloadAllTapped).toHaveBeenCalledOnce();
    expect(deps.trackDownloadAllTapped).toHaveBeenCalledWith({ boardCount: 5, offlineEngineEnabled: false });
  });

  it('still tracks the tap, but shows no toast, when every board is already on the phone', () => {
    const { deps } = makeDeps({ missingBoardCount: () => 0 });
    makeAutoOfflineBoardsToggle(deps)(true);
    expect(deps.rememberDownloadAllTap).toHaveBeenCalledOnce();
    expect(deps.trackDownloadAllTapped).toHaveBeenCalledWith({ boardCount: 0, offlineEngineEnabled: true });
    expect(deps.showToast).not.toHaveBeenCalled();
  });

  it('counts the missing boards at the tap, not when the handler was built', () => {
    let missing = 0;
    const { deps } = makeDeps({ missingBoardCount: () => missing });
    const toggle = makeAutoOfflineBoardsToggle(deps);
    missing = 2;
    toggle(true);
    expect(deps.showToast).toHaveBeenCalledWith('downloading 2');
  });
});

describe('makeAutoOfflineBoardsToggle — switching off', () => {
  it('persists the switch and forgets an unspent tap, without tracking or a toast', () => {
    const { deps, calls } = makeDeps();
    makeAutoOfflineBoardsToggle(deps)(false);
    expect(calls).toEqual(['set:false', 'forget']);
    expect(deps.rememberDownloadAllTap).not.toHaveBeenCalled();
    expect(deps.trackDownloadAllTapped).not.toHaveBeenCalled();
    expect(deps.showToast).not.toHaveBeenCalled();
    expect(deps.missingBoardCount).not.toHaveBeenCalled();
  });
});
