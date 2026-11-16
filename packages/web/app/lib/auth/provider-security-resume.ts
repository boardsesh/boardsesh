import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const providerSecurityResumeLocaleSchema = z.enum(['en-US', 'es', 'fr', 'de', 'it']);

export function providerSecurityResumeUrl(canonicalOrigin: string, operationKey: string, locale: unknown = 'en-US') {
  const origin = new URL(canonicalOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== canonicalOrigin) throw new Error('Invalid Settings origin');
  const selected = providerSecurityResumeLocaleSchema.parse(locale);
  const destination = new URL(selected === 'en-US' ? '/settings' : `/${selected}/settings`, origin);
  destination.searchParams.set('providerSecurityResume', digest.parse(operationKey));
  return destination.href;
}
