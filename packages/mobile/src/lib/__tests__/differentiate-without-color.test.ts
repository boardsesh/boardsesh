import { beforeEach, describe, expect, it, vi } from 'vitest';

type ChangeListener = (payload: { enabled: boolean }) => void;
type AppStateListener = (state: string) => void;

const mocks = vi.hoisted(() => ({
  native: null as null | {
    isDifferentiateWithoutColorEnabled: () => Promise<boolean>;
    addListener: (event: string, listener: ChangeListener) => { remove: () => void };
  },
  changeListeners: [] as ChangeListener[],
  appStateListeners: [] as AppStateListener[],
  read: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock('../../../modules/accessibility-ui/src/index', () => ({
  get accessibilityUINative() {
    return mocks.native;
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: AppStateListener) => {
      mocks.appStateListeners.push(listener);
      return { remove: () => {} };
    },
  },
}));

function linkNative(): void {
  mocks.native = {
    isDifferentiateWithoutColorEnabled: () => mocks.read(),
    addListener: (_event, listener) => {
      mocks.changeListeners.push(listener);
      return { remove: () => {} };
    },
  };
}

async function loadSignal() {
  vi.resetModules();
  return import('../differentiate-without-color');
}

beforeEach(() => {
  mocks.native = null;
  mocks.changeListeners = [];
  mocks.appStateListeners = [];
  mocks.read.mockReset();
  mocks.read.mockResolvedValue(false);
});

describe('differentiate-without-color signal', () => {
  it('stays unknown on a binary without the module (Android, older builds)', async () => {
    const signal = await loadSignal();

    signal.startDifferentiateWithoutColorSignal();

    expect(signal.getDifferentiateWithoutColor()).toBe('unknown');
    expect(mocks.appStateListeners).toHaveLength(0);
  });

  it('reads the setting and follows the change event', async () => {
    linkNative();
    mocks.read.mockResolvedValue(true);
    const signal = await loadSignal();
    const heard = vi.fn();
    signal.subscribeDifferentiateWithoutColor(heard);

    signal.startDifferentiateWithoutColorSignal();
    await vi.waitFor(() => expect(signal.getDifferentiateWithoutColor()).toBe('on'));

    mocks.changeListeners[0]?.({ enabled: false });
    expect(signal.getDifferentiateWithoutColor()).toBe('off');
    expect(heard.mock.calls).toEqual([['on'], ['off']]);
  });

  it('re-reads when the app comes back from Settings', async () => {
    linkNative();
    const signal = await loadSignal();
    signal.startDifferentiateWithoutColorSignal();
    await vi.waitFor(() => expect(signal.getDifferentiateWithoutColor()).toBe('off'));

    mocks.read.mockResolvedValue(true);
    mocks.appStateListeners[0]?.('active');

    await vi.waitFor(() => expect(signal.getDifferentiateWithoutColor()).toBe('on'));
  });

  it('keeps unknown when the read rejects, never off', async () => {
    linkNative();
    mocks.read.mockRejectedValue(new Error('gone'));
    const signal = await loadSignal();

    signal.startDifferentiateWithoutColorSignal();
    await Promise.resolve();
    await Promise.resolve();

    expect(signal.getDifferentiateWithoutColor()).toBe('unknown');
  });

  it('does not replace a newer notification with an older async query', async () => {
    linkNative();
    let resolveRead: (enabled: boolean) => void = () => {};
    mocks.read.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const signal = await loadSignal();
    signal.startDifferentiateWithoutColorSignal();

    mocks.changeListeners[0]?.({ enabled: true });
    resolveRead(false);
    await Promise.resolve();
    expect(signal.getDifferentiateWithoutColor()).toBe('on');
  });

  it('ignores an older query when a foreground read finishes first', async () => {
    linkNative();
    let resolveFirst: (enabled: boolean) => void = () => {};
    mocks.read.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    mocks.read.mockResolvedValueOnce(true);
    const signal = await loadSignal();
    signal.startDifferentiateWithoutColorSignal();
    mocks.appStateListeners[0]?.('active');
    await vi.waitFor(() => expect(signal.getDifferentiateWithoutColor()).toBe('on'));

    resolveFirst(false);
    await Promise.resolve();
    expect(signal.getDifferentiateWithoutColor()).toBe('on');
  });

  it('starts once', async () => {
    linkNative();
    const signal = await loadSignal();

    signal.startDifferentiateWithoutColorSignal();
    signal.startDifferentiateWithoutColorSignal();

    expect(mocks.changeListeners).toHaveLength(1);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
});
