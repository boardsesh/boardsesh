import { afterEach, describe, expect, it, vi } from 'vitest';

const openValidatedUrl = vi.hoisted(() =>
  vi.fn(async (url: string, validate: (candidate: string) => boolean) => validate(url)),
);
vi.mock('../open-external-link', () => ({ openValidatedUrl }));
import { openUserDataExportDownload } from '../user-data-export-download';
import { openUserDataExportDownload as openWebDownload } from '../user-data-export-download.web';
import { isUserDataExportDownloadUrl } from '../user-data-export-download-url';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('export browser handoff', () => {
  it('uses the existing system-browser helper on native', async () => {
    expect(await openUserDataExportDownload('https://private.test/history.json?signature=short-lived')).toBe(true);
    expect(openValidatedUrl).toHaveBeenCalledWith(
      'https://private.test/history.json?signature=short-lived',
      isUserDataExportDownloadUrl,
    );
  });

  it.each([
    'http://private.test/history.json',
    'file:///tmp/export.json',
    'javascript:alert(1)',
    'https://user:secret@private.test/export',
    'not a URL',
  ])('rejects a non-download URL: %s', async (url) => {
    expect(isUserDataExportDownloadUrl(url)).toBe(false);
    expect(await openUserDataExportDownload(url)).toBe(false);
  });

  it('navigates the existing browser tab after asynchronous link retrieval', async () => {
    const assign = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('window', { location: { assign }, open });
    await Promise.resolve();
    expect(await openWebDownload('https://private.test/history.json?signature=new')).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://private.test/history.json?signature=new');
    expect(open).not.toHaveBeenCalled();
  });

  it('reports a failed browser navigation and does not navigate unsafe URLs', async () => {
    const assign = vi.fn(() => {
      throw new Error('navigation blocked');
    });
    vi.stubGlobal('window', { location: { assign } });
    expect(await openWebDownload('https://private.test/history.json')).toBe(false);
    expect(await openWebDownload('javascript:alert(1)')).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('fails without a browser rather than accessing DOM globals during SSR', async () => {
    vi.stubGlobal('window', undefined);
    expect(await openWebDownload('https://private.test/history.json')).toBe(false);
  });
});
