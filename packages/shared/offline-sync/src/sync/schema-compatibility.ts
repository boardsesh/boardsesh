import { LATEST_SCHEMA_VERSION } from '../db/migrations';

export type SchemaDriftReport = {
  tableName: string;
  column: string;
  origin: 'snapshot' | 'pull';
  direction: 'extra-source-column';
  clientSchemaVersion: number;
  artifactSchemaVersion?: number;
};

export type SchemaDriftReporter = (drift: SchemaDriftReport) => void;

const reportedColumns = new Set<string>();

/** Additive columns are compatible across independently deployed clients/servers. */
export function reportExtraColumn(
  reporter: SchemaDriftReporter | undefined,
  report: Omit<SchemaDriftReport, 'direction' | 'clientSchemaVersion'>,
): void {
  if (!reporter) return;
  const key = `${report.origin}:${report.tableName}:${report.column}`;
  if (reportedColumns.has(key)) return;
  reportedColumns.add(key);
  try {
    reporter({ ...report, direction: 'extra-source-column', clientSchemaVersion: LATEST_SCHEMA_VERSION });
  } catch {
    // Observational callbacks must never turn a compatible import into a failure.
  }
}

export class SnapshotSchemaCompatibilityError extends Error {
  constructor(
    readonly tableName: string,
    readonly direction: 'missing-local-column' | 'missing-source-column' | 'invalid-version',
    readonly columns: readonly string[],
    readonly artifactSchemaVersion: unknown,
    readonly clientSchemaVersion = LATEST_SCHEMA_VERSION,
  ) {
    super(`snapshot bootstrap: incompatible schema for ${tableName}: ${direction} ${columns.join(', ')}`);
    this.name = 'SnapshotSchemaCompatibilityError';
  }
}
