/** Enable only after the duplicate queue has been reviewed and merges verified. */
export function gymDirectoryIndexingEnabled(): boolean {
  return process.env.GYM_DIRECTORY_INDEXING_ENABLED === 'true';
}
