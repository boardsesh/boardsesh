import type { GymMcpScope } from './auth';
import type { GymMcpTool } from './registry';

/** Explain hidden tools without granting access or exposing any gym content. */
export function gymMcpCapabilities(
  scopes: readonly string[],
  isGlobalAdmin: boolean,
  tools: readonly Pick<GymMcpTool, 'name' | 'scope' | 'category'>[],
) {
  const actions = [
    ...tools,
    { name: 'get_gym_image_source', scope: 'gyms:read' as GymMcpScope, category: 'profile' },
    { name: 'set_gym_image', scope: 'gyms:write' as GymMcpScope, category: 'profile' },
    { name: 'remove_gym_image', scope: 'gyms:write' as GymMcpScope, category: 'profile' },
  ];
  return {
    grantedScopes: scopes.filter((scope) => scope !== 'offline_access'),
    isGlobalAdmin,
    actions: actions.map(({ name, scope, category }) => {
      const missingScope = !scopes.includes(scope);
      const requiresGlobalAdmin = category === 'admin';
      return {
        name,
        requiredScope: scope,
        requiresGlobalAdmin,
        available: !missingScope && (!requiresGlobalAdmin || isGlobalAdmin),
        ...(missingScope ? { nextAction: `Reconnect to Boardsesh and request ${scope}.` } : {}),
        ...(requiresGlobalAdmin && !isGlobalAdmin
          ? { missingCapability: 'A current global Boardsesh admin role is required.' }
          : {}),
      };
    }),
    note: 'Scopes allow tool discovery. Current gym roles and resource permissions are checked on every call.',
  };
}
