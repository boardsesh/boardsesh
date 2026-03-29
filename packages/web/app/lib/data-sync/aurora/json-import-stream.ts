import type { ImportProgressEvent, ImportResult } from './json-import';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { IMPORT_AURORA_JSON } from '@/app/lib/graphql/operations/aurora-import';

interface ImportAuroraJsonResponse {
  importAuroraJson: {
    ascents: { imported: number; skipped: number; failed: number };
    attempts: { imported: number; skipped: number; failed: number };
    circuits: { imported: number; skipped: number; failed: number };
    unresolvedClimbs: string[];
    claimedUsername: string | null;
  };
}

/**
 * Imports Aurora JSON export data via the GraphQL backend service.
 *
 * Previously this used chunked REST requests to the Next.js API route
 * (which had a 300s Vercel Lambda timeout). Now it sends the full data
 * to the backend GraphQL service which has no timeout constraints.
 */
export async function streamImport(
  boardType: 'kilter' | 'tension',
  data: unknown,
  onEvent: (event: ImportProgressEvent) => void,
  authToken?: string | null,
): Promise<void> {
  const typedData = data as {
    user: { username: string; email_address?: string; created_at?: string };
    ascents?: unknown[];
    attempts?: unknown[];
    circuits?: unknown[];
  };

  const totalItems = (typedData.ascents?.length ?? 0) +
    (typedData.attempts?.length ?? 0) +
    (typedData.circuits?.length ?? 0);

  // Show a progress indicator while the backend processes
  onEvent({
    type: 'progress',
    step: 'resolving',
    message: `Importing ${totalItems} items...`,
  });

  try {
    const response = await executeGraphQL<ImportAuroraJsonResponse>(
      IMPORT_AURORA_JSON,
      {
        input: {
          boardType,
          data: {
            user: typedData.user,
            ascents: typedData.ascents ?? [],
            attempts: typedData.attempts ?? [],
            circuits: typedData.circuits ?? [],
          },
        },
      },
      authToken,
    );

    const result: ImportResult = {
      ascents: response.importAuroraJson.ascents,
      attempts: response.importAuroraJson.attempts,
      circuits: response.importAuroraJson.circuits,
      unresolvedClimbs: response.importAuroraJson.unresolvedClimbs,
    };

    onEvent({ type: 'complete', results: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed';
    onEvent({ type: 'error', error: message });
  }
}
