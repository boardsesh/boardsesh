import { describe, expect, it } from 'vitest';
import { classifySprayUploadFailure, sprayUploadNotice } from '../spray-upload-notice';

// #5960: an upload with Offline mode on failed with the generic error. The fix
// must not swing the other way and hide a server refusal (the wall cap) behind
// a connectivity sentence.

/** What graphql-request throws for a resolver refusal: a reply, with a code. */
function graphqlRefusal(code: string) {
  return Object.assign(new Error('refused'), {
    response: { status: 200, errors: [{ message: 'You have 10 walls', extensions: { code } }] },
  });
}

/** What RN fetch throws when the request never left the phone. */
const transportFailure = new TypeError('Network request failed');

/** What the app's own client throws when it refuses to send (Offline mode). */
function backendUnavailable(reason: string) {
  return Object.assign(new Error('offline'), { name: 'BackendUnavailableError', reason });
}

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

describe('classifySprayUploadFailure', () => {
  it('keeps a server refusal on its own message, whatever connectivity says', () => {
    expect(classifySprayUploadFailure(graphqlRefusal('SPRAY_WALL_CAP'), 'device_offline')).toBeNull();
    expect(classifySprayUploadFailure(graphqlRefusal('SPRAY_WALL_CAP'), 'offline_mode')).toBeNull();
  });

  it('keeps a coded server answer on its own message, even on a 503', () => {
    const codedOutage = Object.assign(new Error('busy'), {
      response: { status: 503, errors: [{ message: 'Try later', extensions: { code: 'RATE_LIMITED' } }] },
    });
    expect(classifySprayUploadFailure(codedOutage, null)).toBeNull();
  });

  it('keeps an ordinary error on its own message', () => {
    expect(classifySprayUploadFailure(new Error('The photo upload failed'), 'device_offline')).toBeNull();
  });

  it('names the cause of a request that never got an answer', () => {
    expect(classifySprayUploadFailure(transportFailure, 'device_offline')).toBe('noSignal');
    expect(classifySprayUploadFailure(transportFailure, 'backend_unreachable')).toBe('serverUnreachable');
    expect(classifySprayUploadFailure(transportFailure, null)).toBe('noSignal');
  });

  it('trusts the reason the app gave when it refused to send', () => {
    expect(classifySprayUploadFailure(backendUnavailable('offline_mode'), null)).toBe('offlineMode');
  });

  it('reads a 503 from the edge as the server being unreachable', () => {
    expect(classifySprayUploadFailure(Object.assign(new Error('bad gateway'), { status: 503 }), null)).toBe(
      'serverUnreachable',
    );
  });
});
