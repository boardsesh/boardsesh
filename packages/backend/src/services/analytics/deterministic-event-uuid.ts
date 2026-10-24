import { createHash } from 'node:crypto';

/**
 * A UUID derived from a name, so a second send of the same aggregate (an
 * operator re-running a job, or a scheduled re-emit) is the same PostHog event
 * and collapses into the first instead of doubling it. RFC 4122 name-based
 * layout (version 5 nibble, variant bits) over SHA-1 of the name alone, with
 * no namespace UUID: the name carries its own `boardsesh:<series>:` prefix.
 *
 * The output for a given name must never change. Every event sent under it
 * would stop collapsing into its re-sends, so `active-users-snapshot.test.ts`
 * pins one value from the implementation that first shipped.
 */
export function deterministicEventUuid(name: string): string {
  const digest = createHash('sha1').update(name).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
