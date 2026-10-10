import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));
const prefetch = vi.hoisted(() => vi.fn<(uris: string[], cachePolicy: string) => Promise<boolean>>());

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));
vi.mock('expo-image', () => ({ Image: { prefetch } }));

async function loadModule() {
  vi.resetModules();
  return import('../warm-board-art-memory');
}

describe('warmBoardArtMemory', () => {
  beforeEach(() => {
    platform.os = 'ios';
    prefetch.mockReset();
    prefetch.mockResolvedValue(true);
  });

  it('decodes local files into memory and then reports them as in memory', async () => {
    const { isBoardArtInMemory, warmBoardArtMemory } = await loadModule();
    expect(isBoardArtInMemory('file:///cache/a.png')).toBe(false);

    warmBoardArtMemory(['file:///cache/a.png']);
    expect(prefetch).toHaveBeenCalledWith(['file:///cache/a.png'], 'memory');
    // Not until the decode has actually finished.
    expect(isBoardArtInMemory('file:///cache/a.png')).toBe(false);
    await vi.waitFor(() => expect(isBoardArtInMemory('file:///cache/a.png')).toBe(true));
  });

  // The no-network rule: board art is never fetched. Anything that is not a file
  // on the phone is dropped before expo-image sees it.
  it('never hands expo-image anything but file URIs', async () => {
    const { warmBoardArtMemory } = await loadModule();
    warmBoardArtMemory(['https://example.com/images/board.png', 'file:///cache/a.png', '/bare/path.png']);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith(['file:///cache/a.png'], 'memory');

    prefetch.mockClear();
    warmBoardArtMemory(['https://example.com/images/board.png']);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('does not report a file as in memory when the decode failed', async () => {
    const { isBoardArtInMemory, warmBoardArtMemory } = await loadModule();
    prefetch.mockResolvedValueOnce(false);
    warmBoardArtMemory(['file:///cache/a.png']);
    await Promise.resolve();
    await Promise.resolve();
    expect(isBoardArtInMemory('file:///cache/a.png')).toBe(false);

    prefetch.mockRejectedValueOnce(new Error('decode failed'));
    warmBoardArtMemory(['file:///cache/b.png']);
    await Promise.resolve();
    await Promise.resolve();
    expect(isBoardArtInMemory('file:///cache/b.png')).toBe(false);
  });

  // expo-image's Android prefetch loads a GlideUrl, which never matches the key
  // a view uses for a local file: it would warm nothing.
  it('does nothing on Android', async () => {
    platform.os = 'android';
    const { isBoardArtInMemory, warmBoardArtMemory } = await loadModule();
    warmBoardArtMemory(['file:///cache/a.png']);
    expect(prefetch).not.toHaveBeenCalled();
    expect(isBoardArtInMemory('file:///cache/a.png')).toBe(false);
  });
});

describe('the in-memory record', () => {
  beforeEach(() => {
    platform.os = 'ios';
  });

  it('counts a file a view has loaded, on either platform', async () => {
    platform.os = 'android';
    const { isBoardArtInMemory, noteBoardArtInMemory } = await loadModule();
    noteBoardArtInMemory('file:///cache/a.png');
    expect(isBoardArtInMemory('file:///cache/a.png')).toBe(true);
    expect(isBoardArtInMemory(null)).toBe(false);
    expect(isBoardArtInMemory(undefined)).toBe(false);
  });

  it('forgets everything when the image memory cache is swept', async () => {
    const { forgetBoardArtInMemory, isBoardArtInMemory, noteBoardArtInMemory } = await loadModule();
    noteBoardArtInMemory('file:///cache/a.png');
    forgetBoardArtInMemory();
    expect(isBoardArtInMemory('file:///cache/a.png')).toBe(false);
  });

  // The image cache is capped by bytes; believing in more files than fit would
  // show bare boards for the ones it has already evicted.
  it('keeps only the most recent files, and a re-noted file counts as recent', async () => {
    const { isBoardArtInMemory, noteBoardArtInMemory } = await loadModule();
    for (let index = 0; index < 240; index++) noteBoardArtInMemory(`file:///cache/${index}.png`);
    noteBoardArtInMemory('file:///cache/0.png');
    noteBoardArtInMemory('file:///cache/overflow.png');

    expect(isBoardArtInMemory('file:///cache/0.png')).toBe(true);
    expect(isBoardArtInMemory('file:///cache/1.png')).toBe(false);
    expect(isBoardArtInMemory('file:///cache/overflow.png')).toBe(true);
  });
});
