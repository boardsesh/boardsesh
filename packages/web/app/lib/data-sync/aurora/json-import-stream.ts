import * as Sentry from '@sentry/nextjs';
import type { ImportProgressEvent, ImportResult } from './json-import';
import type { AuroraBoardName } from '@boardsesh/shared-schema';

const CHUNK_SIZE = 500;

type ChunkPayload = {
  boardType: AuroraBoardName;
  data: {
    user: { username: string; email_address?: string; created_at?: string };
    ascents: unknown[];
    attempts: unknown[];
    circuits: unknown[];
    climbs: unknown[];
  };
  skipFinalization: boolean;
};

type StreamImportOptions = {
  backendUrl?: string | null;
  authToken?: string | null;
};

/**
 * Splits an array into chunks of the given size.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Merges two ImportResult objects by summing their counts.
 */
function mergeResults(a: ImportResult, b: ImportResult): ImportResult {
  const merged: ImportResult = {
    ascents: {
      imported: a.ascents.imported + b.ascents.imported,
      skipped: a.ascents.skipped + b.ascents.skipped,
      failed: a.ascents.failed + b.ascents.failed,
    },
    attempts: {
      imported: a.attempts.imported + b.attempts.imported,
      skipped: a.attempts.skipped + b.attempts.skipped,
      failed: a.attempts.failed + b.attempts.failed,
    },
    circuits: {
      imported: a.circuits.imported + b.circuits.imported,
      skipped: a.circuits.skipped + b.circuits.skipped,
      failed: a.circuits.failed + b.circuits.failed,
    },
    climbs: {
      imported: a.climbs.imported + b.climbs.imported,
      skipped: a.climbs.skipped + b.climbs.skipped,
      failed: a.climbs.failed + b.climbs.failed,
    },
    unresolvedClimbs: [...new Set([...a.unresolvedClimbs, ...b.unresolvedClimbs])],
    unresolvedAscentClimbs: [...new Set([...a.unresolvedAscentClimbs, ...b.unresolvedAscentClimbs])].sort(),
    unresolvedAttemptClimbs: [...new Set([...a.unresolvedAttemptClimbs, ...b.unresolvedAttemptClimbs])].sort(),
    unresolvedCircuitClimbs: [...new Set([...a.unresolvedCircuitClimbs, ...b.unresolvedCircuitClimbs])].sort(),
  };
  // Preserve every chunk's error — if multiple chunks fail, dropping earlier
  // messages would hide diagnostics. Join with a separator the UI can split on.
  const errors = [a.partialError, b.partialError].filter((m): m is string => !!m);
  if (errors.length > 0) {
    merged.partialError = errors.join('\n');
  }
  return merged;
}

/**
 * Sends a single chunk to the import endpoint and reads the streaming response.
 * Returns the ImportResult from the 'complete' event, or throws on error.
 */
async function sendChunk(
  payload: ChunkPayload,
  onEvent: (event: ImportProgressEvent) => void,
  options: StreamImportOptions,
): Promise<ImportResult> {
  if (!options.backendUrl) {
    throw new Error('Import endpoint is not configured');
  }

  const endpoint = `${options.backendUrl.replace(/\/+$/, '')}/api/aurora-import`;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.authToken) {
    headers.set('Authorization', `Bearer ${options.authToken}`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = 'Import failed';
    try {
      const errorBody = await response.json();
      message = errorBody.error || message;
    } catch {
      // Response body isn't valid JSON (e.g. HTML error page)
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('No response body');
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
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.trim()) {
        let event: ImportProgressEvent;
        try {
          event = JSON.parse(line);
        } catch {
          console.warn('Failed to parse import stream line:', line);
          continue;
        }
        if (event.type === 'complete') {
          result = event.results;
        } else if (event.type === 'error') {
          throw new Error(event.error);
        } else if (event.type === 'progress') {
          onEvent(event);
        }
      }
    }
  }

  if (buffer.trim()) {
    let event: ImportProgressEvent;
    try {
      event = JSON.parse(buffer);
    } catch {
      console.warn('Failed to parse import stream buffer:', buffer);
      if (!result) {
        throw new Error('Import was interrupted: server response ended without a result');
      }
      return result;
    }
    if (event.type === 'complete') {
      result = event.results;
    } else if (event.type === 'error') {
      throw new Error(event.error);
    }
  }

  if (!result) {
    throw new Error('Import was interrupted: server response ended without a result');
  }

  return result;
}

/**
 * Streams an Aurora JSON import, splitting data into chunks to stay within
 * Vercel's request body size limits. Each chunk is sent as a separate request
 * and results are merged client-side.
 */
export async function streamImport(
  boardType: AuroraBoardName,
  data: unknown,
  onEvent: (event: ImportProgressEvent) => void,
  options: StreamImportOptions = {},
): Promise<void> {
  const typedData = data as {
    user: { username: string; email_address?: string; created_at?: string };
    ascents?: unknown[];
    attempts?: unknown[];
    circuits?: unknown[];
    climbs?: unknown[];
  };

  const user = typedData.user;
  const ascents = typedData.ascents ?? [];
  const attempts = typedData.attempts ?? [];
  const circuits = typedData.circuits ?? [];
  const climbs = typedData.climbs ?? [];

  // Build list of chunks to send
  const ascentChunks = chunk(ascents, CHUNK_SIZE);
  const attemptChunks = chunk(attempts, CHUNK_SIZE);

  const allChunks: ChunkPayload[] = [];
  const emptyData = {
    user,
    ascents: [] as unknown[],
    attempts: [] as unknown[],
    circuits: [] as unknown[],
    climbs: [] as unknown[],
  };

  // Climbs go in the FIRST chunk so they're imported before name resolution
  if (climbs.length > 0) {
    allChunks.push({
      boardType,
      data: { ...emptyData, climbs },
      skipFinalization: true,
    });
  }

  for (const batch of ascentChunks) {
    allChunks.push({
      boardType,
      data: { ...emptyData, ascents: batch },
      skipFinalization: true,
    });
  }

  for (const batch of attemptChunks) {
    allChunks.push({
      boardType,
      data: { ...emptyData, attempts: batch },
      skipFinalization: true,
    });
  }

  // Circuits go in a later chunk
  if (circuits.length > 0) {
    allChunks.push({
      boardType,
      data: { ...emptyData, circuits },
      skipFinalization: true,
    });
  }

  // If no data at all, send a single empty chunk
  if (allChunks.length === 0) {
    allChunks.push({
      boardType,
      data: emptyData,
      skipFinalization: false,
    });
  }

  // The last chunk runs final import correction after all ticks are present.
  allChunks[allChunks.length - 1].skipFinalization = false;

  const emptyResult: ImportResult = {
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    circuits: { imported: 0, skipped: 0, failed: 0 },
    climbs: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    unresolvedAscentClimbs: [],
    unresolvedAttemptClimbs: [],
    unresolvedCircuitClimbs: [],
  };

  let merged = emptyResult;
  const totalChunks = allChunks.length;

  for (let i = 0; i < totalChunks; i++) {
    onEvent({
      type: 'progress',
      step: 'resolving',
      message: `Processing batch ${i + 1} of ${totalChunks}...`,
    });

    const chunk = allChunks[i];
    try {
      const chunkResult = await sendChunk(chunk, onEvent, options);
      merged = mergeResults(merged, chunkResult);
    } catch (error) {
      // Earlier chunks may have already committed server-side. Capture the
      // failure with rich context, attach a partialError to the merged result,
      // and let the UI render the summary panel as a partial success.
      const message = error instanceof Error ? error.message : 'Import failed';
      Sentry.captureException(error, {
        tags: { area: 'aurora-import', phase: 'client-chunk' },
        extra: {
          boardType,
          chunkIndex: i,
          totalChunks,
          chunkSummary: {
            ascents: chunk.data.ascents.length,
            attempts: chunk.data.attempts.length,
            circuits: chunk.data.circuits.length,
            climbs: chunk.data.climbs.length,
          },
          mergedSoFar: merged,
        },
      });
      merged = {
        ...merged,
        partialError: merged.partialError ? `${merged.partialError}\n${message}` : message,
      };
      break;
    }
  }

  onEvent({ type: 'complete', results: merged });
}
