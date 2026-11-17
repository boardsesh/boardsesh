import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fromModule: vi.fn(),
  materialize: vi.fn<(uri: string, hash: string | null, type: string) => Promise<string>>(),
  constructed: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-asset', () => ({
  Asset: class {
    localUri: string | null = null;
    constructor(private options: { uri: string; hash: string | null; type: string }) {
      mocks.constructed(options);
    }
    static fromModule = mocks.fromModule;
    async downloadAsync() {
      this.localUri = await mocks.materialize(this.options.uri, this.options.hash, this.options.type);
      return this;
    }
  },
}));
vi.mock('../board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: {
    'kilter/product_sizes_layouts_sets/36-1.webp': 100,
    'kilter/product_sizes_layouts_sets/38-1.webp': 101,
  },
}));
vi.mock('../board-details', () => ({
  getBoardRenderData: ({ sizeId }: { sizeId: number }) => ({
    boardWidth: 1080,
    boardHeight: 1504,
    edgeLeft: 0,
    edgeRight: 11,
    edgeBottom: 0,
    edgeTop: 18,
    holdsData: [],
    backgroundImageKeys: [`kilter/product_sizes_layouts_sets/${sizeId === 26 ? '38-1' : '36-1'}.webp`],
  }),
}));

const params = { boardName: 'kilter' as const, layoutId: 8, sizeId: 25, setIds: [26] };
const resourceName = '_web_public_images_kilter_product_sizes_layouts_sets_36_1';
const assetMetadata = {
  name: '36-1',
  uri: resourceName,
  hash: 'ab'.repeat(16),
  type: 'webp',
  width: 1080,
  height: 1504,
};

function downloadedDrawable() {
  const drawable = {
    ...assetMetadata,
    localUri: resourceName,
    downloaded: true,
    // Expo's embedded Android shortcut makes this a no-op, even though
    // native file consumers cannot open the drawable resource name.
    downloadAsync: vi.fn(async () => drawable),
  };
  return drawable;
}

describe('embedded Android board photographs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.materialize.mockReset().mockResolvedValue('file:///cache/ExponentAsset-content.webp');
    mocks.fromModule.mockReset().mockReturnValue(downloadedDrawable());
  });

  it('copies a downloaded drawable to a file while retaining its content identity', async () => {
    const drawable = downloadedDrawable();
    mocks.fromModule.mockReturnValue(drawable);
    const { ensureBackgroundsCached, tryGetBackgroundPathsSync } = await import('../background-image-cache');
    expect(tryGetBackgroundPathsSync(params)).toEqual({ paths: [], missingCount: 1 });
    await expect(ensureBackgroundsCached(params)).resolves.toEqual({
      paths: ['/cache/ExponentAsset-content.webp'],
      missingCount: 0,
    });
    expect(mocks.constructed).toHaveBeenCalledWith(assetMetadata);
    expect(mocks.materialize).toHaveBeenCalledWith(resourceName, assetMetadata.hash, 'webp');
    expect(drawable.downloadAsync).not.toHaveBeenCalled();
    expect(drawable.localUri).toBe(resourceName);
    expect(tryGetBackgroundPathsSync(params)).toEqual({
      paths: ['/cache/ExponentAsset-content.webp'],
      missingCount: 0,
    });
  });

  it('shares one materialization between concurrent consumers', async () => {
    let finish: ((uri: string) => void) | undefined;
    mocks.materialize.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const { ensureBackgroundsCached } = await import('../background-image-cache');
    const first = ensureBackgroundsCached(params);
    const second = ensureBackgroundsCached(params);
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Materialization did not begin');
    finish('file:///cache/shared.webp');
    await expect(Promise.all([first, second])).resolves.toEqual([
      { paths: ['/cache/shared.webp'], missingCount: 0 },
      { paths: ['/cache/shared.webp'], missingCount: 0 },
    ]);
  });

  it('shares the native content-cache copy between different manifest aliases', async () => {
    let finish: ((uri: string) => void) | undefined;
    mocks.materialize.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    mocks.fromModule.mockImplementation((moduleId: number) => ({
      ...downloadedDrawable(),
      uri: moduleId === 100 ? resourceName : `${resourceName}_alias`,
    }));
    const { ensureBackgroundsCached, tryGetBackgroundPathsSync } = await import('../background-image-cache');
    const first = ensureBackgroundsCached(params);
    const aliasParams = { ...params, sizeId: 26 };
    const alias = ensureBackgroundsCached(aliasParams);
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
    expect(mocks.constructed).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Materialization did not begin');
    finish('file:///cache/shared-content.webp');
    await expect(Promise.all([first, alias])).resolves.toEqual([
      { paths: ['/cache/shared-content.webp'], missingCount: 0 },
      { paths: ['/cache/shared-content.webp'], missingCount: 0 },
    ]);
    expect(tryGetBackgroundPathsSync(params)?.paths).toEqual(['/cache/shared-content.webp']);
    expect(tryGetBackgroundPathsSync(aliasParams)?.paths).toEqual(['/cache/shared-content.webp']);
  });

  it('keeps failed copies missing and permits a later retry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.materialize.mockRejectedValueOnce(new Error('Resource copy failed'));
    try {
      const { ensureBackgroundsCached } = await import('../background-image-cache');
      await expect(ensureBackgroundsCached(params)).resolves.toEqual({ paths: [], missingCount: 1 });
      await expect(ensureBackgroundsCached(params)).resolves.toEqual({
        paths: ['/cache/ExponentAsset-content.webp'],
        missingCount: 0,
      });
      expect(mocks.materialize).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it('keeps the ordinary file fast path', async () => {
    mocks.fromModule.mockReturnValue({ ...downloadedDrawable(), localUri: 'file:///bundled/photo.webp' });
    const { ensureBackgroundsCached } = await import('../background-image-cache');
    await expect(ensureBackgroundsCached(params)).resolves.toEqual({ paths: ['/bundled/photo.webp'], missingCount: 0 });
    expect(mocks.constructed).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('uses the original download path for development HTTP assets', async () => {
    const remote = {
      ...assetMetadata,
      uri: 'http://localhost:8081/assets/photo.webp',
      localUri: null as string | null,
      downloadAsync: vi.fn(async () => {
        remote.localUri = 'file:///cache/dev-photo.webp';
        return remote;
      }),
    };
    mocks.fromModule.mockReturnValue(remote);
    const { ensureBackgroundsCached } = await import('../background-image-cache');
    await expect(ensureBackgroundsCached(params)).resolves.toEqual({
      paths: ['/cache/dev-photo.webp'],
      missingCount: 0,
    });
    expect(remote.downloadAsync).toHaveBeenCalledOnce();
    expect(mocks.constructed).not.toHaveBeenCalled();
  });
});
