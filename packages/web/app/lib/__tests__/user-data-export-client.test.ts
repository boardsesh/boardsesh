import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { requestAndDeliverUserDataExport } from '../user-data-export-client';

vi.mock('@/app/lib/backend-url', () => ({
  getBackendHttpUrl: () => 'http://backend.test',
}));

const fetchMock = vi.fn();
const createObjectURLMock = vi.fn();
const revokeObjectURLMock = vi.fn();
const anchorClickMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  createObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue('blob:export');
  revokeObjectURLMock.mockReset();
  anchorClickMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURLMock,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURLMock,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClickMock);
  Object.defineProperty(window, 'Capacitor', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReadyExportResponses() {
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: 'ready', downloadUrl: '/api/user-data-export/download?boardType=kilter' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    .mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="boardsesh-kilter-export-2026-W19.json"',
        },
      }),
    );
}

describe('user data export client', () => {
  it('requests and downloads an Aurora JSON export in the browser', async () => {
    mockReadyExportResponses();

    await expect(requestAndDeliverUserDataExport('kilter', 'test-token')).resolves.toBe('downloaded');

    expect(fetchMock.mock.calls[0]).toEqual([
      'http://backend.test/api/user-data-export?boardType=kilter',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
        },
      },
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      'http://backend.test/api/user-data-export/download?boardType=kilter',
      {
        headers: {
          Authorization: 'Bearer test-token',
        },
      },
    ]);
    expect(createObjectURLMock).toHaveBeenCalled();
    expect(anchorClickMock).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:export');
  });

  it('shares an Aurora JSON export through native Capacitor file sharing in the app', async () => {
    const writeFileMock = vi.fn().mockResolvedValue({ uri: 'file://boardsesh-export.json' });
    const shareMock = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(window, 'Capacitor', {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: {
          Filesystem: { writeFile: writeFileMock },
          Share: { canShare: vi.fn().mockResolvedValue({ value: true }), share: shareMock },
        },
      },
    });
    mockReadyExportResponses();

    await expect(requestAndDeliverUserDataExport('kilter', 'test-token')).resolves.toBe('shared');

    expect(writeFileMock).toHaveBeenCalledWith({
      path: 'exports/boardsesh-kilter-export-2026-W19.json',
      data: 'e30=',
      directory: 'CACHE',
      recursive: true,
    });
    expect(shareMock).toHaveBeenCalledWith({
      title: 'boardsesh-kilter-export-2026-W19.json',
      text: 'Boardsesh logbook export',
      url: 'file://boardsesh-export.json',
      dialogTitle: 'Save export',
    });
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(anchorClickMock).not.toHaveBeenCalled();
  });

  it('does not fall back to a false browser download in a native app without sharing support', async () => {
    Object.defineProperty(window, 'Capacitor', {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: {},
      },
    });
    mockReadyExportResponses();

    await expect(requestAndDeliverUserDataExport('kilter', 'test-token')).rejects.toThrow(
      'Export needs a newer Boardsesh app build on this device.',
    );

    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(anchorClickMock).not.toHaveBeenCalled();
  });
});
