import { describe, expect, it } from 'vitest';
import { sprayUploadNotice } from '../spray-upload-notice';

// #5960: an upload with Offline mode on failed with the generic error.
describe('sprayUploadNotice', () => {
  it('names each offline cause', () => {
    expect(sprayUploadNotice('offline_mode')).toBe('offlineMode');
    expect(sprayUploadNotice('device_offline')).toBe('noSignal');
    expect(sprayUploadNotice('backend_unreachable')).toBe('serverUnreachable');
  });

  it('says nothing extra while online', () => {
    expect(sprayUploadNotice(null)).toBeNull();
  });
});
