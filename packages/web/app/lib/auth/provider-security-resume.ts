import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  providerSecurityResumeVersion: z.literal(1),
  outcome: z.literal('resumable'),
  operationKey: digest,
  actorContextKey: digest,
  provider: z.enum(['google', 'apple']),
  reauthenticationReady: z.boolean(),
};

/** Public UI metadata only. Neither this selector nor a claimed ready bit is
 * authentication evidence; every command re-admits actual cookie possession. */
export const providerSecurityResumeSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('link'), methodId: z.null() }).strict(),
  z.object({ ...common, action: z.literal('unlink'), methodId: digest }).strict(),
]);
export type ProviderSecurityResume = z.infer<typeof providerSecurityResumeSchema>;
export const providerSecurityResumeLocaleSchema = z.enum(['en-US', 'es', 'fr', 'de', 'it']);

export function providerSecurityResumeUrl(canonicalOrigin: string, operationKey: string, locale: unknown = 'en-US') {
  const origin = new URL(canonicalOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== canonicalOrigin) throw new Error('Invalid Settings origin');
  const selected = providerSecurityResumeLocaleSchema.parse(locale);
  const destination = new URL(selected === 'en-US' ? '/settings' : `/${selected}/settings`, origin);
  destination.searchParams.set('providerSecurityResume', digest.parse(operationKey));
  return destination.href;
}
