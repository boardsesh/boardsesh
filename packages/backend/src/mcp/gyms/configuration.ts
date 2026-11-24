import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  parseGymMcpMode,
  type GymMcpMode,
} from '@boardsesh/auth-protocol/partner-oauth';
import { readPartnerOAuthMode } from '../../auth/partner/mode';

export { GYM_MCP_RESOURCE, GYM_MCP_SCOPES, type GymMcpMode };
export type GymMcpScope = 'gyms:read' | 'gyms:write' | 'gyms:access:write';

export interface GymMcpConfiguration {
  mode: Exclude<GymMcpMode, 'off'>;
  pilotUserIds: readonly string[];
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
  };
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
