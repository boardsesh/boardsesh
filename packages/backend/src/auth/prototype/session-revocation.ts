/** Eligibility and authentication age are independent authority facts. */
export function prototypeSessionPassesRevocation(
  session: { createdAt: Date; revocationGeneration?: number | null },
  cutoff: { revokedThrough: Date; generation: number } | null | undefined,
): boolean {
  if (session.revocationGeneration !== null && session.revocationGeneration !== undefined)
    return session.revocationGeneration === (cutoff?.generation ?? 0);
  if (!cutoff) return true;
  // Only pre-generation fixture/import rows use the original conservative rule.
  return session.createdAt.getTime() > cutoff.revokedThrough.getTime();
}
