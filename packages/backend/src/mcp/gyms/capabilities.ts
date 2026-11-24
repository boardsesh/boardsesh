import type { GymMcpTool } from './registry';
import { GYM_MCP_ADMIN_SCOPES } from './configuration';
import { gymMcpMediaToolMetadata } from './media-tool-metadata';

/** Explain hidden tools without granting access or exposing any gym content. */
export function gymMcpCapabilities(
  scopes: readonly string[],
  isGlobalAdmin: boolean | null,
  tools: readonly Pick<GymMcpTool, 'name' | 'scope' | 'category'>[],
) {
  const actions = [...tools, ...gymMcpMediaToolMetadata];
  const adminStatus = GYM_MCP_ADMIN_SCOPES.some((scope) => scopes.includes(scope)) ? isGlobalAdmin : null;
  return {
    grantedScopes: scopes.filter((scope) => scope !== 'offline_access'),
    isGlobalAdmin: adminStatus,
    actions: actions.map(({ name, scope, category }) => {
      const missingScope = !scopes.includes(scope);
      const requiresGlobalAdmin = category === 'admin';
      return {
        name,
        requiredScope: scope,
        requiresGlobalAdmin,
        available: !missingScope && (!requiresGlobalAdmin || adminStatus === true),
        ...(missingScope ? { nextAction: `Reconnect to Boardsesh and request ${scope}.` } : {}),
        ...(requiresGlobalAdmin && adminStatus === false
          ? { missingCapability: 'A current global Boardsesh admin role is required.' }
          : {}),
      };
    }),
    note: 'Scopes allow tool discovery. Global admin status is checked only with an explicit admin scope; otherwise it is null. Current gym roles and resource permissions are checked on every call.',
  };
}
