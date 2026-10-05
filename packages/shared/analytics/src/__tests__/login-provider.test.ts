import { describe, expect, it } from 'vitest';
import { loginProviderProperties } from '../login-provider';

describe('loginProviderProperties', () => {
  it('spells the email sign-in "email" while auth_method keeps its old value', () => {
    expect(loginProviderProperties('credentials')).toEqual({ auth_method: 'credentials', provider: 'email' });
  });

  it.each(['google', 'apple'] as const)('names %s the same in both props', (authMethod) => {
    expect(loginProviderProperties(authMethod)).toEqual({ auth_method: authMethod, provider: authMethod });
  });
});
