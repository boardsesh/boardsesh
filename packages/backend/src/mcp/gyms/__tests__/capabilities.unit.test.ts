import { describe, expect, it } from 'vitest';
import { gymMcpCapabilities } from '../capabilities';

const tools = [
  { name: 'get_gym', scope: 'gyms:read', category: 'overview' },
  { name: 'update_gym_profile', scope: 'gyms:write', category: 'profile' },
  { name: 'inspect_gym_duplicates', scope: 'gyms:admin:read', category: 'admin' },
] as const;

describe('gym MCP scope discovery', () => {
  it('does not disclose account-specific global admin status without explicit admin scope consent', () => {
    const adminAccount = gymMcpCapabilities(['gyms:read', 'gyms:write'], true, tools);
    const ordinaryAccount = gymMcpCapabilities(['gyms:read', 'gyms:write'], false, tools);
    expect(adminAccount).toEqual(ordinaryAccount);
    expect(adminAccount.isGlobalAdmin).toBeNull();
    expect(adminAccount.actions[2]).toMatchObject({
      requiredScope: 'gyms:admin:read',
      requiresGlobalAdmin: true,
      available: false,
    });
    expect(adminAccount.actions[2]).not.toHaveProperty('missingCapability');
  });

  it('names the missing profile and image scope without enabling the tools', () => {
    const result = gymMcpCapabilities(['gyms:read'], false, tools);
    for (const name of ['update_gym_profile', 'set_gym_image', 'remove_gym_image']) {
      expect(result.actions.find((action) => action.name === name)).toMatchObject({
        available: false,
        requiredScope: 'gyms:write',
        nextAction: 'Reconnect to Boardsesh and request gyms:write.',
      });
    }
    expect(result.actions.find((action) => action.name === 'get_gym')?.available).toBe(true);
  });

  it('requires both explicit admin consent and a current global role', () => {
    expect(gymMcpCapabilities(['gyms:read'], true, tools).actions[2]).toMatchObject({
      available: false,
      requiredScope: 'gyms:admin:read',
    });
    expect(gymMcpCapabilities(['gyms:admin:read'], false, tools).actions[2]).toMatchObject({
      available: false,
      missingCapability: 'A current global Boardsesh admin role is required.',
    });
    expect(gymMcpCapabilities(['gyms:admin:read'], true, tools).actions[2].available).toBe(true);
  });
});
