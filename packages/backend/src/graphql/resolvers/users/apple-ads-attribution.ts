import { z } from 'zod';
import { ANALYTICS_CONSENT_CHOICES, CONSENT_SOURCES, isAnalyticsGranted, resolveConsent } from '@boardsesh/consent';
import type { AppleAdsAttributionResult, AppleAdsConsentInput, ConnectionContext } from '@boardsesh/shared-schema';
import { appleAdsTerminalResult, exchangeAppleAdsToken } from '../../../services/apple-ads-attribution';
import { checkRateLimitRedis } from '../../../utils/redis-rate-limiter';
import { RateLimitError } from '../../../utils/rate-limiter';
import { readAnalyticsConsentForUser } from './analytics-consent';

const consentSnapshotSchema = z.object({
  analytics: z.enum(ANALYTICS_CONSENT_CHOICES),
  version: z.number().int().positive().max(1_000),
  source: z.enum(CONSENT_SOURCES),
  decidedAt: z
    .string()
    .max(64)
    .refine((timestamp) => {
      const timestampMs = Date.parse(timestamp);
      return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === timestamp;
    }),
});

async function isExchangeAllowed(consent: AppleAdsConsentInput, ctx: ConnectionContext): Promise<boolean> {
  if (!isAnalyticsGranted(consent)) return false;
  if (ctx.credentialExpiresAt !== undefined && ctx.credentialExpiresAt <= Date.now()) return false;
  if (ctx.authCredentialProvided && (!ctx.isAuthenticated || !ctx.userId)) return false;
  if (ctx.isAuthenticated && !ctx.userId) return false;
  const accountConsent = ctx.userId ? await readAnalyticsConsentForUser(ctx.userId) : null;
  return isAnalyticsGranted(resolveConsent(consent, accountConsent));
}

export const appleAdsAttributionMutations = {
  exchangeAppleAdsAttribution: async (
    _: unknown,
    { token, consent }: { token: string; consent: AppleAdsConsentInput },
    ctx: ConnectionContext,
  ): Promise<AppleAdsAttributionResult> => {
    // The native client always uses HTTP. Avoid admitting this sensitive token
    // through WebSocket error/reporting paths or anonymous cron contexts.
    if (ctx.transport !== 'http' || ctx.isCronAuthenticated) return appleAdsTerminalResult('CONSENT_REQUIRED');
    const parsedConsent = consentSnapshotSchema.safeParse(consent);
    if (!parsedConsent.success) return appleAdsTerminalResult('CONSENT_REQUIRED');

    try {
      if (!(await isExchangeAllowed(parsedConsent.data, ctx))) return appleAdsTerminalResult('CONSENT_REQUIRED');

      // Unlike the general mutation helper, anonymous HTTP gets a distributed
      // bucket too. Keys contain no attribution token or campaign identifier.
      const callerIdentity = ctx.isAuthenticated && ctx.userId ? ctx.userId : `ip:${ctx.clientIp ?? 'unknown'}`;
      await checkRateLimitRedis(callerIdentity, 'apple-ads-attribution', 20, 60_000);
      await checkRateLimitRedis(
        `socket-peer:${ctx.socketPeerIp ?? 'unknown'}`,
        'apple-ads-attribution-peer',
        600,
        60_000,
      );

      const result = await exchangeAppleAdsToken(token);
      // A denial elsewhere during the exchange suppresses even a successful
      // response. The client separately checks its local consent/owner generation.
      if (!(await isExchangeAllowed(parsedConsent.data, ctx))) return appleAdsTerminalResult('CONSENT_REQUIRED');
      return result;
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          status: 'RETRYABLE',
          attribution: null,
          retryAfterSeconds: error.retryAfterSeconds,
          retryReason: 'rate_limited',
        };
      }
      // Account reads may fail too. Never expose an exception carrying this
      // mutation's variables through generic GraphQL logging/error reporting.
      return { status: 'RETRYABLE', attribution: null, retryAfterSeconds: 5, retryReason: 'unavailable' };
    }
  },
};
