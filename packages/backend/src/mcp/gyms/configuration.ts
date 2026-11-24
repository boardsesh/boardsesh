import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  GYM_MCP_DEFAULT_SCOPES,
  GYM_MCP_ADMIN_SCOPES,
  parseGymMcpMode,
  type GymMcpMode,
} from '@boardsesh/auth-protocol/partner-oauth';
import { readPartnerOAuthMode } from '../../auth/partner/mode';
import { logger } from '../../utils/logger';

export { GYM_MCP_RESOURCE, GYM_MCP_SCOPES, GYM_MCP_DEFAULT_SCOPES, GYM_MCP_ADMIN_SCOPES, type GymMcpMode };
export type GymMcpScope = Exclude<(typeof GYM_MCP_SCOPES)[number], 'offline_access'>;
export const DEFAULT_GYM_MCP_PILOT_CLIENT_ORIGINS = ['https://chatgpt.com', 'https://claude.ai'] as const;
const INVALID_PILOT_ORIGINS_WARNING_INTERVAL_MS = 60_000;
let lastInvalidPilotOriginsWarningAt: number | undefined;

export interface GymMcpConfiguration {
  mode: Exclude<GymMcpMode, 'off'>;
  pilotUserIds: readonly string[];
  pilotClientOrigins?: readonly string[];
}

function pilotClientOrigins(rawOrigins: string | undefined): readonly string[] {
  if (rawOrigins === undefined) return DEFAULT_GYM_MCP_PILOT_CLIENT_ORIGINS;
  try {
    return [
      ...new Set(
        rawOrigins
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
          .map((origin) => {
            const parsed = new URL(origin);
            if (
              parsed.protocol !== 'https:' ||
              parsed.username ||
              parsed.password ||
              parsed.pathname !== '/' ||
              parsed.search ||
              parsed.hash
            ) {
              throw new Error('Invalid gym MCP pilot origin');
            }
            return parsed.origin;
          }),
      ),
    ];
  } catch {
    // Gym discovery must fail closed without taking the training authority
    // offline. Repeated configuration reads emit at most one safe warning/min.
    const now = Date.now();
    if (
      lastInvalidPilotOriginsWarningAt === undefined ||
      now - lastInvalidPilotOriginsWarningAt >= INVALID_PILOT_ORIGINS_WARNING_INTERVAL_MS
    ) {
      lastInvalidPilotOriginsWarningAt = now;
      logger.warn('Gym MCP pilot client origins invalid; metadata discovery denied', {
        code: 'INVALID_PILOT_CLIENT_ORIGINS',
      });
    }
    return [];
  }
}

export function readGymMcpMode(rawMode: string | undefined = process.env.GYM_MCP_MODE): GymMcpMode {
  return parseGymMcpMode(rawMode);
}

export function readGymMcpConfiguration(environment: NodeJS.ProcessEnv = process.env): GymMcpConfiguration | undefined {
  const mode = parseGymMcpMode(environment.GYM_MCP_MODE);
  if (mode === 'off') return undefined;
  return {
    mode,
    pilotUserIds: (environment.GYM_MCP_PILOT_USER_IDS ?? '')
      .split(',')
      .map((userId) => userId.trim())
      .filter(Boolean),
    ...(mode === 'pilot' ? { pilotClientOrigins: pilotClientOrigins(environment.GYM_MCP_PILOT_CLIENT_ORIGINS) } : {}),
  };
}

/** Pilot identity policy applies before sign-in, fetching, caching or client persistence. */
export function gymMcpAllowsClientMetadata(configuration: GymMcpConfiguration | undefined, clientId: string): boolean {
  if (configuration?.mode !== 'pilot') return true;
  try {
    const origin = new URL(clientId).origin;
    return (configuration.pilotClientOrigins ?? DEFAULT_GYM_MCP_PILOT_CLIENT_ORIGINS).includes(origin);
  } catch {
    return false;
  }
}

export function gymMcpAllowsUser(configuration: GymMcpConfiguration | undefined, userId: string): boolean {
  return (
    configuration?.mode === 'on' || (configuration?.mode === 'pilot' && configuration.pilotUserIds.includes(userId))
  );
}

/** The partner authority's hold/off switch always wins over the gym switch. */
export function gymMcpIsServing(): boolean {
  const parentMode = readPartnerOAuthMode();
  return (parentMode === 'allowlist' || parentMode === 'open') && readGymMcpMode() !== 'off';
}
