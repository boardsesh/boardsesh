import { describe, expect, it } from 'vitest';
import { isNetworkError } from '../../mutation-queue/error-classification';
import {
  classifySnapshotTransferFailure,
  isSnapshotBackgroundDecodeError,
  SnapshotTransferError,
} from '../snapshot-transfer-failure';

describe('snapshot transfer failures', () => {
  it.each([
    'Unable to download a file: Connection reset',
    'Unable to download a file: Software caused connection abort',
    'Unable to download a file: Failed to connect to snapshots.boardsesh.com/104.21.81.90:443',
  ])('recovers the observed native transport error: %s', (message) => {
    const cause = new Error('Native DownloadTask rejected', { cause: new Error(message) });
    expect(classifySnapshotTransferFailure(cause)).toEqual({ reason: 'network', retryable: true, expected: true });
    // Snapshot classification must not expand the mutation queue's replay policy.
    expect(isNetworkError(cause)).toBe(false);
  });

  it.each(['cannot decode raw data', '无法解码原始数据', 'Decodieren der Rohdaten nicht möglich'])(
    'recognizes a localized background decode error: %s',
    (message) => {
      const cause = new Error('Unable to download a file', { cause: new Error(message) });
      expect(isSnapshotBackgroundDecodeError(cause)).toBe(true);
      // The platform must establish that this came from a background session.
      expect(classifySnapshotTransferFailure(cause)).toBeNull();
    },
  );

  it('prefers a stable Foundation code when the native exception supplies it', () => {
    expect(isSnapshotBackgroundDecodeError({ domain: 'NSURLErrorDomain', code: -1015 })).toBe(true);
    expect(isSnapshotBackgroundDecodeError({ code: 'NSURLErrorCannotDecodeRawData' })).toBe(true);
    expect(isSnapshotBackgroundDecodeError({ domain: 'AnotherDomain', code: -1015 })).toBe(false);
  });

  it.each([new Error('Unable to download a file: server returned HTTP 416'), { status: 416 }, { statusCode: 416 }])(
    'keeps an HTTP range rejection retryable and distinct from connectivity: %o',
    (cause) => {
      expect(classifySnapshotTransferFailure(new Error('transfer failed', { cause }))).toEqual({
        reason: 'http-range',
        retryable: true,
        expected: false,
      });
    },
  );

  it('preserves the typed classification through another wrapper', () => {
    const cause = new Error('Unable to download a file: Connection reset');
    const normalized = new SnapshotTransferError('network', 'snapshot transfer failed', { cause });
    expect(normalized.cause).toBe(cause);
    expect(classifySnapshotTransferFailure(new Error('wrapper', { cause: normalized }))).toEqual({
      reason: 'network',
      retryable: true,
      expected: true,
    });
  });

  it('recognizes existing stable error names through a plain native cause object', () => {
    expect(classifySnapshotTransferFailure({ cause: { name: 'SnapshotBackgroundTransferInterruptedError' } })).toEqual({
      reason: 'background-transfer-decode',
      retryable: true,
      expected: true,
    });
    expect(classifySnapshotTransferFailure({ cause: { name: 'SnapshotArtifactTruncatedError' } })).toEqual({
      reason: 'artifact-truncated',
      retryable: true,
      expected: false,
    });
  });

  it('names a missing artifact without guessing the cache-loss cause or retry policy', () => {
    expect(
      classifySnapshotTransferFailure(
        new Error('FileSystemFile.open rejected', { cause: { code: 'ENOENT', message: 'No such file or directory' } }),
      ),
    ).toEqual({ reason: 'artifact-missing', retryable: false, expected: false });
    expect(classifySnapshotTransferFailure(new Error('ENOENT (No such file or directory)'))?.reason).toBe(
      'artifact-missing',
    );
  });

  it.each([
    'insufficient disk space',
    'EACCES: permission denied',
    'unable to open database: /cache/grades.db',
    'Unable to download a file: server returned HTTP 404',
    'BLE connection reset',
    'Cannot read property fetch of undefined',
  ])('leaves other failures unchanged: %s', (message) => {
    expect(classifySnapshotTransferFailure(new Error(message))).toBeNull();
  });

  it('bounds cause traversal and tolerates cycles', () => {
    const cyclicCause = { cause: null as unknown };
    cyclicCause.cause = cyclicCause;
    expect(classifySnapshotTransferFailure(cyclicCause)).toBeNull();
    expect(isSnapshotBackgroundDecodeError(cyclicCause)).toBe(false);
    let deeplyWrapped: unknown = new Error('Unable to download a file: Connection reset');
    for (let depth = 0; depth < 4; depth += 1) deeplyWrapped = new Error('wrapper', { cause: deeplyWrapped });
    expect(classifySnapshotTransferFailure(deeplyWrapped)).toBeNull();
  });
});
