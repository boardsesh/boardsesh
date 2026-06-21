import * as WebBrowser from 'expo-web-browser';
import { type AuroraBoardName } from '@boardsesh/shared-schema';
import type { ImportProgressEvent, ImportResult, StrippedAuroraExportData } from '@boardsesh/shared-schema';
import { authenticatedFetch } from './auth-interceptor';
import { parseDeepLinkQueryParams } from './deep-link-query';
import { BACKEND_URL } from './env';

const CHUNK_SIZE = 500;
const KILTER_REDIRECT_URL = 'com.boardsesh.app://board-credentials/kilter';

export type AuroraCredentialStatus = {
  boardType: string;
  auroraUsername: string;
  auroraUserId: number | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: string;
};

export type AuroraCredentialsResponse = {
  credentials: AuroraCredentialStatus[];
  kilterSyncAllowed: boolean;
};

export type UnsyncedCounts = Record<
  string,
  {
    ascents: number;
    climbs: number;
  }
>;

export type DeleteCredentialResult =
  | { success: true }
  | { success: false; localCleared: true; reason: 'revocation_failed' };

export type KilterConnectResult = 'connected' | 'cancelled' | 'error' | 'not_allowed';

export type BoardAccountErrorCode =
  | 'invalid_credentials'
  | 'not_allowed'
  | 'rate_limited'
  | 'request_failed'
  | 'unauthorized';

export class BoardAccountError extends Error {
  readonly code: BoardAccountErrorCode;

  constructor(code: BoardAccountErrorCode) {
    super(code);
    this.name = 'BoardAccountError';
    this.code = code;
  }
}

type ChunkPayload = {
  boardType: AuroraBoardName;
  data: StrippedAuroraExportData;
  skipFinalization: boolean;
};

function endpoint(path: string): string {
  return `${BACKEND_URL.replace(/\/+$/, '')}${path}`;
}

async function readErrorPayload(response: Response): Promise<{ error?: string }> {
  try {
    return (await response.json()) as { error?: string };
  } catch {
    return {};
  }
}

function errorCodeForResponse(response: Response, payload: { error?: string }): BoardAccountErrorCode {
  if (response.status === 401 && payload.error === 'Invalid Aurora credentials') return 'invalid_credentials';
  if (response.status === 401) return 'unauthorized';
  if (response.status === 403) return 'not_allowed';
  if (response.status === 429) return 'rate_limited';
  return 'request_failed';
}

function buildRequestHeaders(headers: RequestInit['headers'], hasJsonBody: boolean): Headers {
  const mergedHeaders = new Headers(headers);
  if (hasJsonBody) {
    mergedHeaders.set('Content-Type', 'application/json');
  }
  return mergedHeaders;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(endpoint(path), {
    ...init,
    headers: buildRequestHeaders(init.headers, Boolean(init.body)),
  });

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new BoardAccountError(errorCodeForResponse(response, payload));
  }

  return (await response.json()) as T;
}

export async function getAuroraCredentials(): Promise<AuroraCredentialsResponse> {
  return requestJson<AuroraCredentialsResponse>('/api/aurora-credentials');
}

export async function getAuroraUnsyncedCounts(): Promise<UnsyncedCounts> {
  const response = await requestJson<{ counts: UnsyncedCounts }>('/api/aurora-credentials/unsynced');
  return response.counts;
}

export async function saveAuroraCredential(input: {
  boardType: AuroraBoardName;
  username: string;
  password: string;
}): Promise<AuroraCredentialStatus> {
  const response = await requestJson<{ credential: AuroraCredentialStatus }>('/api/aurora-credentials', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.credential;
}

export async function deleteAuroraCredential(boardType: AuroraBoardName): Promise<DeleteCredentialResult> {
  return requestJson<DeleteCredentialResult>('/api/aurora-credentials', {
    method: 'DELETE',
    body: JSON.stringify({ boardType }),
  });
}

async function createKilterHandoffStartUrl(): Promise<string> {
  const response = await requestJson<{ startUrl: string }>('/api/board-credentials/kilter/handoff', {
    method: 'POST',
  });
  return response.startUrl;
}

async function finalizeKilterCredential(completion: string): Promise<void> {
  await requestJson<{ success: true }>('/api/board-credentials/kilter/finalize', {
    method: 'POST',
    body: JSON.stringify({ completion }),
  });
}

export async function connectKilterAccount(): Promise<KilterConnectResult> {
  let startUrl: string;
  try {
    startUrl = await createKilterHandoffStartUrl();
  } catch (error) {
    if (error instanceof BoardAccountError && error.code === 'not_allowed') return 'not_allowed';
    return 'error';
  }

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(startUrl, KILTER_REDIRECT_URL);
  } catch {
    return 'error';
  }

  if (result.type !== 'success') return 'cancelled';

  const params = parseDeepLinkQueryParams(result.url);
  const status = params.get('status');
  if (status === 'connected') {
    const completion = params.get('completion');
    if (!completion) return 'error';
    try {
      await finalizeKilterCredential(completion);
      return 'connected';
    } catch (error) {
      if (error instanceof BoardAccountError && error.code === 'not_allowed') return 'not_allowed';
      return 'error';
    }
  }
  return 'error';
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += size) {
    chunks.push(items.slice(itemIndex, itemIndex + size));
  }
  return chunks;
}

function emptyImportResult(): ImportResult {
  return {
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    circuits: { imported: 0, skipped: 0, failed: 0 },
    climbs: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    unresolvedAscentClimbs: [],
    unresolvedAttemptClimbs: [],
    unresolvedCircuitClimbs: [],
  };
}

function mergeResults(first: ImportResult, second: ImportResult): ImportResult {
  const merged: ImportResult = {
    ascents: {
      imported: first.ascents.imported + second.ascents.imported,
      skipped: first.ascents.skipped + second.ascents.skipped,
      failed: first.ascents.failed + second.ascents.failed,
    },
    attempts: {
      imported: first.attempts.imported + second.attempts.imported,
      skipped: first.attempts.skipped + second.attempts.skipped,
      failed: first.attempts.failed + second.attempts.failed,
    },
    circuits: {
      imported: first.circuits.imported + second.circuits.imported,
      skipped: first.circuits.skipped + second.circuits.skipped,
      failed: first.circuits.failed + second.circuits.failed,
    },
    climbs: {
      imported: first.climbs.imported + second.climbs.imported,
      skipped: first.climbs.skipped + second.climbs.skipped,
      failed: first.climbs.failed + second.climbs.failed,
    },
    unresolvedClimbs: [...new Set([...first.unresolvedClimbs, ...second.unresolvedClimbs])],
    unresolvedAscentClimbs: [...new Set([...first.unresolvedAscentClimbs, ...second.unresolvedAscentClimbs])].sort(),
    unresolvedAttemptClimbs: [...new Set([...first.unresolvedAttemptClimbs, ...second.unresolvedAttemptClimbs])].sort(),
    unresolvedCircuitClimbs: [...new Set([...first.unresolvedCircuitClimbs, ...second.unresolvedCircuitClimbs])].sort(),
  };

  const errors = [first.partialError, second.partialError].filter((message): message is string => !!message);
  if (errors.length > 0) {
    merged.partialError = errors.join('\n');
  }

  return merged;
}

function parseImportEvent(line: string): ImportProgressEvent | null {
  try {
    return JSON.parse(line) as ImportProgressEvent;
  } catch {
    return null;
  }
}

async function handleImportEvent(
  event: ImportProgressEvent,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<{ type: 'complete'; result: ImportResult } | { type: 'error'; error: string } | { type: 'progress' }> {
  if (event.type === 'complete') {
    return { type: 'complete', result: event.results };
  }
  if (event.type === 'error') {
    return { type: 'error', error: event.error };
  }
  onEvent(event);
  return { type: 'progress' };
}

function hasReadableBody(body: Response['body']): body is NonNullable<Response['body']> {
  return !!body && typeof body.getReader === 'function';
}

async function readStreamingImportResponse(
  response: Response,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<ImportResult> {
  if (!hasReadableBody(response.body)) {
    return readTextImportResponse(response, onEvent);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ImportResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseImportEvent(line);
      if (!event) continue;
      const eventResult = await handleImportEvent(event, onEvent);
      if (eventResult.type === 'complete') result = eventResult.result;
      if (eventResult.type === 'error') throw new Error(eventResult.error);
    }
  }

  if (buffer.trim()) {
    const event = parseImportEvent(buffer);
    if (event) {
      const eventResult = await handleImportEvent(event, onEvent);
      if (eventResult.type === 'complete') result = eventResult.result;
      if (eventResult.type === 'error') throw new Error(eventResult.error);
    }
  }

  if (!result) throw new Error('import_interrupted');
  return result;
}

async function readTextImportResponse(
  response: Response,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<ImportResult> {
  const text = await response.text();
  let result: ImportResult | null = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const event = parseImportEvent(line);
    if (!event) continue;
    const eventResult = await handleImportEvent(event, onEvent);
    if (eventResult.type === 'complete') result = eventResult.result;
    if (eventResult.type === 'error') throw new Error(eventResult.error);
  }

  if (!result) throw new Error('import_interrupted');
  return result;
}

async function sendImportChunk(
  payload: ChunkPayload,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<ImportResult> {
  const response = await authenticatedFetch(endpoint('/api/aurora-import'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('import_failed');
  }

  return readStreamingImportResponse(response, onEvent);
}

export async function streamAuroraImport(
  boardType: AuroraBoardName,
  data: StrippedAuroraExportData,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<void> {
  const emptyData: StrippedAuroraExportData = {
    user: data.user,
    ascents: [],
    attempts: [],
    circuits: [],
    climbs: [],
  };

  const chunks: ChunkPayload[] = [];
  if (data.climbs.length > 0) {
    chunks.push({ boardType, data: { ...emptyData, climbs: data.climbs }, skipFinalization: true });
  }

  for (const ascents of chunk(data.ascents, CHUNK_SIZE)) {
    chunks.push({ boardType, data: { ...emptyData, ascents }, skipFinalization: true });
  }

  for (const attempts of chunk(data.attempts, CHUNK_SIZE)) {
    chunks.push({ boardType, data: { ...emptyData, attempts }, skipFinalization: true });
  }

  if (data.circuits.length > 0) {
    chunks.push({ boardType, data: { ...emptyData, circuits: data.circuits }, skipFinalization: true });
  }

  if (chunks.length === 0) {
    chunks.push({ boardType, data: emptyData, skipFinalization: false });
  }

  chunks[chunks.length - 1].skipFinalization = false;

  let merged = emptyImportResult();
  let successfulChunks = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    onEvent({
      type: 'progress',
      step: 'resolving',
      message: `${chunkIndex + 1}/${chunks.length}`,
    });

    try {
      const result = await sendImportChunk(chunks[chunkIndex], onEvent);
      merged = mergeResults(merged, result);
      successfulChunks += 1;
    } catch (error) {
      if (successfulChunks === 0) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'import_failed';
      merged = {
        ...merged,
        partialError: merged.partialError ? `${merged.partialError}\n${message}` : message,
      };
      break;
    }
  }

  onEvent({ type: 'complete', results: merged });
}
