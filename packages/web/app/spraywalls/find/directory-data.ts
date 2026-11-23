import 'server-only';
import * as Sentry from '@sentry/nextjs';
import type { SearchSprayWallsDirectoryQueryResponse } from '@boardsesh/graphql/operations';
import type { DirectoryQuery } from '@/app/gyms/directory-facets';
import { compactErrorMessage } from '@/app/lib/observability/compact-error';
import { sprayDirectoryInput } from './directory-model';
import { requestSprayDirectory } from './directory-request';

export type SprayDirectoryResult =
  | { ok: true; connection: SearchSprayWallsDirectoryQueryResponse['searchBoards'] }
  | { ok: false };

export async function fetchSprayDirectory(query: DirectoryQuery): Promise<SprayDirectoryResult> {
  try {
    return { ok: true, connection: await requestSprayDirectory(sprayDirectoryInput(query)) };
  } catch (error) {
    console.error('[spray-wall-directory] search failed:', compactErrorMessage(error));
    Sentry.captureException(error, { tags: { surface: 'spray-wall-directory', operation: 'publicSprayWalls' } });
    return { ok: false };
  }
}
