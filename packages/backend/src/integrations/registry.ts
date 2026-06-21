// Maps the DB `provider` column and the GraphQL IntegrationProvider enum to
// concrete provider implementations. Adding a provider means adding it here
// plus to SUPPORTED_PROVIDERS and the enum-mapping tables.

import type { IntegrationProvider } from '@boardsesh/shared-schema';
import type { IntegrationProviderImpl } from './types';
import { stravaProvider } from './strava';

/** DB-level provider names. */
export type ProviderName = 'strava';

/** Provider names we currently support, in display order. */
export const SUPPORTED_PROVIDERS: readonly ProviderName[] = ['strava'];

const PROVIDERS: Record<ProviderName, IntegrationProviderImpl> = {
  strava: stravaProvider,
};

/** GraphQL enum value → DB provider name. */
const ENUM_TO_DB: Record<IntegrationProvider, ProviderName> = {
  STRAVA: 'strava',
};

/** DB provider name → GraphQL enum value. */
const DB_TO_ENUM: Record<ProviderName, IntegrationProvider> = {
  strava: 'STRAVA',
};

export function isSupportedProvider(name: string): name is ProviderName {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(name);
}

export function getProvider(dbName: string): IntegrationProviderImpl | null {
  if (!isSupportedProvider(dbName)) return null;
  return PROVIDERS[dbName];
}

export function providerEnumToDb(provider: IntegrationProvider): ProviderName {
  return ENUM_TO_DB[provider];
}

export function providerDbToEnum(dbName: ProviderName): IntegrationProvider {
  return DB_TO_ENUM[dbName];
}
