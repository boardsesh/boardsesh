export type PendingLookups = Map<string, { ids: Set<string>; found: Promise<ReadonlySet<string>> }>;

/**
 * Answer every lookup made under one key in the same pass with a single call.
 * graphql-js resolves the fields of a list one item and one field at a time;
 * like DataLoader, `lookup` runs after the promise jobs already queued, so every
 * sibling field and list item started in this pass has asked by then. Nothing
 * outlives the batch, so a privacy change applies to the next projection.
 */
export function batchedLookup(
  pending: PendingLookups,
  key: string,
  ids: Iterable<string | null | undefined>,
  lookup: (ids: string[]) => Promise<ReadonlySet<string>>,
): Promise<ReadonlySet<string>> {
  let batch = pending.get(key);
  if (!batch) {
    const batchIds = new Set<string>();
    const found = new Promise<ReadonlySet<string>>((resolve, reject) => {
      void Promise.resolve().then(() =>
        process.nextTick(() => {
          pending.delete(key);
          lookup([...batchIds]).then(resolve, reject);
        }),
      );
    });
    batch = { ids: batchIds, found };
    pending.set(key, batch);
  }
  for (const id of ids) if (id) batch.ids.add(id);
  return batch.found;
}
