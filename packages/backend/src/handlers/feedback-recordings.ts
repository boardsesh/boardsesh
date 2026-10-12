import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { FEEDBACK_RECORDING_MAX_UPLOAD_BYTES, FEEDBACK_RECORDING_PREFIX } from '@boardsesh/shared-schema';
import { applyCorsHeaders } from './cors';
import { guardUploadFileStream, sendJson } from './http-utils';
import { extractAuthTokenFromHeader } from './gym-image-upload';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadStreamToS3 } from '../storage/s3';
import { logger } from '../utils/logger';

const EXTENSIONS: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const uploadWindows = new Map<string, { count: number; started: number }>();
const WINDOW_MS = 10 * 60 * 1000;
export function resetFeedbackRecordingRateLimit(): void {
  uploadWindows.clear();
}
function consumeBudget(userId: string): boolean {
  const now = Date.now();
  if (uploadWindows.size >= 1000) {
    for (const [account, window] of uploadWindows) if (now - window.started >= WINDOW_MS) uploadWindows.delete(account);
  }
  const window = uploadWindows.get(userId);
  if (!window || now - window.started >= WINDOW_MS) {
    uploadWindows.set(userId, { count: 1, started: now });
    return true;
  }
  if (window.count >= 8) return false;
  window.count += 1;
  return true;
}

/** Sniff the container, rather than trusting a publicly served upload's MIME. */
export function detectRecordingMimeType(header: Buffer): string | null {
  if (header.length >= 12 && header.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML's DocType element must explicitly name WebM, not generic Matroska.
    const docType = header.indexOf(Buffer.from([0x42, 0x82]));
    if (docType >= 0 && header[docType + 2] === 0x84 && header.toString('ascii', docType + 3, docType + 7) === 'webm')
      return 'video/webm';
    return null;
  }
  if (header.length < 16 || header.toString('ascii', 4, 8) !== 'ftyp') return null;
  const boxLength = header.readUInt32BE(0);
  if (boxLength < 16 || boxLength > header.length || boxLength % 4 !== 0) return null;
  const majorBrand = header.toString('ascii', 8, 12);
  if (majorBrand === 'qt  ') return 'video/quicktime';
  const mp4Brands = new Set([
    'isom',
    'iso2',
    'iso3',
    'iso4',
    'iso5',
    'iso6',
    'mp41',
    'mp42',
    'avc1',
    'M4V ',
    'dash',
    'MSNV',
  ]);
  if (mp4Brands.has(majorBrand)) return 'video/mp4';
  return null;
}

/** Authenticated single-file upload; disk and S3 streams have bounded memory. */
export async function handleFeedbackRecordingUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const rejectRequest = (status: number, error: string) => {
    req.resume();
    if (!res.destroyed && !res.writableEnded) sendJson(res, status, { error });
  };
  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    rejectRequest(401, 'Authentication required');
    return;
  }
  const account = await validateToken(token);
  if (!account) {
    rejectRequest(401, 'Invalid or expired token');
    return;
  }
  if (!consumeBudget(account.userId)) {
    rejectRequest(429, 'Too many recording uploads. Try again in a few minutes.');
    return;
  }
  const useS3 = isS3Configured('media');
  if (!useS3 && process.env.NODE_ENV === 'production') {
    rejectRequest(501, 'Recording uploads are not configured');
    return;
  }

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: req.headers,
      limits: { fileSize: FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 1, files: 1, fields: 0, parts: 2 },
    });
  } catch {
    rejectRequest(400, 'Invalid request format');
    return;
  }
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.on('aborted', onDisconnect);
  req.on('error', onDisconnect);
  if (req.aborted || req.destroyed) abortController.abort();
  res.on('close', onDisconnect);
  let directory: string | undefined;
  let fileWrite: Promise<void> | undefined;
  let mimeType: string | undefined;
  let failure: { status: number; error: string } | undefined;
  let receivedFile = false;
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'boardsesh-feedback-recording-'));
    const temporaryFile = path.join(directory, 'recording');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        parser.destroy(new Error('Client disconnected'));
        reject(new Error('Client disconnected'));
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      parser.once('close', () => abortController.signal.removeEventListener('abort', onAbort));
      parser.on('file', (name, stream, metadata) => {
        guardUploadFileStream(stream, { route: '/api/feedback-recordings', field: name });
        receivedFile = true;
        if (name !== 'recording' || !EXTENSIONS[metadata.mimeType]) {
          failure = { status: 400, error: 'Only MP4, MOV, and WebM recordings are allowed' };
          stream.resume();
          return;
        }
        mimeType = metadata.mimeType;
        stream.on('limit', () => {
          failure = { status: 400, error: 'Recording must be 95 MiB or smaller' };
        });
        let sourceFailed = false;
        stream.once('error', () => {
          sourceFailed = true;
        });
        const destination = createWriteStream(temporaryFile);
        destination.once('error', () => {
          if (!sourceFailed && !abortController.signal.aborted)
            failure = { status: 500, error: 'Failed to save recording' };
        });
        fileWrite = pipeline(stream, destination, { signal: abortController.signal });
        // Attach a handler immediately; await the original before any upload.
        void fileWrite.catch((error: unknown) => {
          failure ??= { status: 400, error: 'Invalid request format' };
          parser.destroy(error instanceof Error ? error : new Error('Failed to write recording'));
        });
      });
      const rejectParts = () => {
        failure = { status: 400, error: 'Upload exactly one recording file' };
      };
      parser.on('filesLimit', rejectParts);
      parser.on('fieldsLimit', rejectParts);
      parser.on('partsLimit', rejectParts);
      parser.once('error', (error: Error) => {
        failure ??= { status: 400, error: 'Invalid request format' };
        reject(error);
      });
      parser.once('finish', resolve);
      if (abortController.signal.aborted) {
        onAbort();
        return;
      }
      req.pipe(parser);
    });
    if (fileWrite) await fileWrite;
    if (failure) {
      rejectRequest(failure.status, failure.error);
      return;
    }
    if (!receivedFile || !mimeType || !fileWrite) {
      rejectRequest(400, 'No recording uploaded');
      return;
    }
    const fileStats = await stat(temporaryFile);
    if (!fileStats.size) {
      rejectRequest(400, 'Uploaded file is empty');
      return;
    }
    if (fileStats.size > FEEDBACK_RECORDING_MAX_UPLOAD_BYTES) {
      rejectRequest(400, 'Recording must be 95 MiB or smaller');
      return;
    }
    const descriptor = await open(temporaryFile, 'r');
    let header: Buffer;
    try {
      header = Buffer.alloc(Math.min(4096, fileStats.size));
      await descriptor.read(header, 0, header.length, 0);
    } finally {
      await descriptor.close();
    }
    if (detectRecordingMimeType(header) !== mimeType) {
      rejectRequest(400, 'File contents do not match the declared recording type');
      return;
    }
    const filename = `${randomUUID()}.${EXTENSIONS[mimeType]}`;
    const key = `${FEEDBACK_RECORDING_PREFIX}/${filename}`;
    if (useS3) {
      const recordingStream = createReadStream(temporaryFile);
      guardUploadFileStream(recordingStream, { route: '/api/feedback-recordings', field: 'recording' });
      try {
        await uploadStreamToS3('media', recordingStream, fileStats.size, key, mimeType, abortController.signal);
      } finally {
        recordingStream.destroy();
        await finished(recordingStream).catch(() => undefined);
      }
    } else {
      abortController.signal.throwIfAborted();
      await mkdir(FEEDBACK_RECORDING_PREFIX, { recursive: true });
      await copyFile(temporaryFile, path.join(FEEDBACK_RECORDING_PREFIX, filename));
    }
    if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { success: true, key });
  } catch (error) {
    if (!abortController.signal.aborted) {
      const status = failure?.status ?? 500;
      if (status >= 500) logger.error('Feedback recording upload failed', error);
      else logger.warn('Feedback recording upload rejected', error);
      rejectRequest(status, failure?.error ?? 'Failed to upload recording');
    }
  } finally {
    req.unpipe(parser);
    parser.destroy();
    if (fileWrite) await fileWrite.catch(() => undefined);
    req.off('aborted', onDisconnect);
    req.off('error', onDisconnect);
    res.off('close', onDisconnect);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
