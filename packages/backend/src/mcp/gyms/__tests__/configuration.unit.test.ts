import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../utils/logger', () => ({ logger: { warn: fixtures.warn } }));

let configuration: typeof import('../configuration');
let partnerConfiguration: typeof import('../../../auth/partner/configuration');
beforeEach(async () => {
  vi.resetModules();
  fixtures.warn.mockClear();
  configuration = await import('../configuration');
  partnerConfiguration = await import('../../../auth/partner/configuration');
});
afterEach(() => vi.useRealTimers());

describe('gym MCP pilot origin configuration isolation', () => {
  it('retains default origins, normalized custom origins, and explicit empty-list denial', () => {
    const pilot: NodeJS.ProcessEnv = { NODE_ENV: 'test', GYM_MCP_MODE: 'pilot' };
    expect(configuration.readGymMcpConfiguration(pilot)?.pilotClientOrigins).toEqual([
      'https://chatgpt.com',
      'https://claude.ai',
    ]);
    expect(
      configuration.readGymMcpConfiguration({
        ...pilot,
        GYM_MCP_PILOT_CLIENT_ORIGINS: ' https://ASSISTANT.example/,https://assistant.example ',
      })?.pilotClientOrigins,
    ).toEqual(['https://assistant.example']);
    expect(
      configuration.readGymMcpConfiguration({ ...pilot, GYM_MCP_PILOT_CLIENT_ORIGINS: ' , ' })?.pilotClientOrigins,
    ).toEqual([]);
    expect(fixtures.warn).not.toHaveBeenCalled();
  });

  it('denies every gym metadata origin when any entry is malformed while preserving training configuration', () => {
    const training: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PARTNER_OAUTH_SECRETS: `1:${'s'.repeat(40)}`,
      NEXTAUTH_SECRET: 'private-nextauth-marker',
      PARTNER_DEVELOPER_TERMS_VERSION: 'training-terms',
      GYM_MCP_MODE: 'pilot',
      GYM_MCP_PILOT_USER_IDS: 'pilot-owner',
    };
    const { gymMcp: _gymMcp, ...expectedTraining } = partnerConfiguration.readPartnerAuthorityConfiguration(training, {
      production: false,
    });
    for (const origins of [
      'invalid-private-marker',
      'http://assistant.example',
      'https://assistant.example/path',
      'https://user:private-password-marker@assistant.example',
      'https://assistant.example?private-query-marker=secret',
      'https://chatgpt.com,https://assistant.example/path',
    ]) {
      const { gymMcp, ...actualTraining } = partnerConfiguration.readPartnerAuthorityConfiguration(
        {
          ...training,
          GYM_MCP_PILOT_CLIENT_ORIGINS: origins,
        },
        { production: false },
      );
      expect(actualTraining).toEqual(expectedTraining);
      expect(gymMcp).toEqual({ mode: 'pilot', pilotUserIds: ['pilot-owner'], pilotClientOrigins: [] });
      for (const clientId of [
        'https://chatgpt.com/client.json',
        'https://claude.ai/client.json',
        'https://assistant.example/client.json',
      ])
        expect(configuration.gymMcpAllowsClientMetadata(gymMcp, clientId)).toBe(false);
    }
    expect(fixtures.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixtures.warn.mock.calls)).not.toMatch(/private-|https:|nextauth/);
  });

  it('bounds warnings to one per minute using only a fixed message and code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T16:00:00Z'));
    const pilot: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      GYM_MCP_MODE: 'pilot',
      GYM_MCP_PILOT_CLIENT_ORIGINS: 'https://user:private-marker@assistant.example',
    };
    for (let attempt = 0; attempt < 20; attempt += 1) configuration.readGymMcpConfiguration(pilot);
    expect(fixtures.warn).toHaveBeenCalledExactlyOnceWith(
      'Gym MCP pilot client origins invalid; metadata discovery denied',
      { code: 'INVALID_PILOT_CLIENT_ORIGINS' },
    );
    vi.setSystemTime(Date.now() + 59_999);
    configuration.readGymMcpConfiguration(pilot);
    expect(fixtures.warn).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 1);
    configuration.readGymMcpConfiguration(pilot);
    expect(fixtures.warn).toHaveBeenCalledTimes(2);
    expect(fixtures.warn.mock.calls[1]).toEqual(fixtures.warn.mock.calls[0]);
  });

  it.each(['off', 'on'])('does not apply the pilot origin override in %s mode', (mode) => {
    const result = configuration.readGymMcpConfiguration({
      NODE_ENV: 'test',
      GYM_MCP_MODE: mode,
      GYM_MCP_PILOT_CLIENT_ORIGINS: 'invalid-private-marker',
    });
    expect(result).toEqual(mode === 'off' ? undefined : { mode: 'on', pilotUserIds: [] });
    expect(fixtures.warn).not.toHaveBeenCalled();
  });
});
