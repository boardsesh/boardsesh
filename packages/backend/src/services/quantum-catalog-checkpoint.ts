import { z } from 'zod';

/** Reserved shared-sync cursor; never forwarded to an upstream table API. */
export const QUANTUM_CATALOG_CHECKPOINT = '__local_catalog_checkpoint__';

const catalogSyncMetadataSchema = z.object({
  source: z.string(),
  revisionId: z.string().optional(),
  revisionTimestamp: z.number().finite().optional(),
  contentFingerprint: z.string().optional(),
  hardwareFingerprint: z.string().optional(),
  lastAttemptAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: z.string().nullable().optional(),
});

export type QuantumCatalogSyncMetadata = z.infer<typeof catalogSyncMetadataSchema>;

export function readQuantumCatalogSyncMetadata(metadata: unknown): QuantumCatalogSyncMetadata {
  // A corrupted persisted binding must never silently become a fresh catalog.
  return catalogSyncMetadataSchema.parse(metadata);
}
