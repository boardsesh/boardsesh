import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildReadinessServerScript } from '../lib/metro-dev-server';
import { MAX_IOS_CAMPAIGN_PHONE_COMMANDS, iosCampaignPhoneScene } from '../lib/ios-campaign-phone-scenes';

/** Execute the actual detached child handler without occupying a capture's port. */
function readinessTransport() {
  let handleRequest:
    | ((
        request: { url: string; socket: { remoteAddress: string } },
        response: { writeHead: (status: number) => void; end: (body?: string) => void },
      ) => void)
    | undefined;
  runInNewContext(buildReadinessServerScript(), {
    URL,
    require: (name: string) => {
      if (name === 'http') {
        return {
          createServer: (handler: NonNullable<typeof handleRequest>) => {
            handleRequest = handler;
            return { listen: () => {} };
          },
        };
      }
      if (name === 'fs') return {};
      throw new Error(`Unexpected readiness dependency ${name}`);
    },
  });
  return (url: string, remoteAddress = '127.0.0.1') => {
    let status = 0;
    let body = '';
    if (!handleRequest) throw new Error('Readiness child did not register a request handler');
    handleRequest(
      { url, socket: { remoteAddress } },
      {
        writeHead: (code) => {
          status = code;
        },
        end: (responseBody = '') => {
          body = responseBody;
        },
      },
    );
    return { status, body };
  };
}

describe('campaign phone readiness commands', () => {
  it('accepts bounded phone scenes and acknowledges the exact sequence', () => {
    const request = readinessTransport();
    expect(MAX_IOS_CAMPAIGN_PHONE_COMMANDS).toBe(32);
    for (const index of [0, 31]) {
      const scene = iosCampaignPhoneScene(index);
      const response = request(`/cpp/set?scene=${scene}`);
      expect(response.status).toBe(200);
      const command = JSON.parse(response.body) as { scene: string; sequence: number };
      expect(command.scene).toBe(`campaign-phone-climbs-${index}`);
      expect(request(`/cpp/ack?sequence=${command.sequence}`).status).toBe(200);
      expect(JSON.parse(request('/cpp/command').body)).toMatchObject({
        scene,
        sequence: command.sequence,
        acknowledged: command.sequence,
      });
    }
  });

  it('rejects out-of-bounds and malformed scenes without changing the active command', () => {
    const request = readinessTransport();
    const active = request('/cpp/set?scene=campaign-phone-climbs-0');
    for (const scene of [
      'campaign-phone-climbs-32',
      'campaign-phone-climbs--1',
      'campaign-phone-climbs-1.5',
      'campaign-phone-climbs-01',
      'campaign-phone-climbs-NaN',
      'campaign-phone-climbs-',
      'campaign-phone-climbs-0-extra',
      'campaign-phone-climbs-invalid',
    ]) {
      expect(request(`/cpp/set?scene=${scene}`).status).toBe(400);
    }
    expect(request('/cpp/set?scene=campaign-phone-climbs-1', '192.0.2.1').status).toBe(403);
    expect(request('/cpp/command').body).toBe(active.body);
  });

  it.each([-1, 32, 1.5, NaN, Infinity])('refuses to build an invalid phone scene index %s', (index) => {
    expect(() => iosCampaignPhoneScene(index)).toThrow('Campaign phone scene index');
  });

  it('retains the existing CPP scene allowlist and loopback restriction', () => {
    const request = readinessTransport();
    for (const scene of [
      'reset',
      'hero-1',
      'hero-2',
      'hero-3',
      'hero-2-editor-list',
      'hero-3-editor-list',
      'other-1',
      'other-2',
      'other-3',
      'accessory-prepare',
      'search',
      'search-grade',
      'search-results',
      'logbook',
      'led',
      'queue-join',
      'queue',
      'workout',
      'status',
      'status-ipad',
      'island',
      'kiosk',
    ]) {
      expect(request(`/cpp/set?scene=${scene}`).status).toBe(200);
    }
    expect(request('/cpp/set?scene=search-grade-other-board').status).toBe(400);
    expect(request('/cpp/set?scene=search-grade', '192.0.2.1').status).toBe(403);
    expect(request('/cpp/unregistered').status).toBe(404);
  });
});
