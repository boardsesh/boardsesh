import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type DevNetworkingPlugin = {
  applyBoardseshDevNetworkingInfoPlist(infoPlist: Record<string, unknown>): Record<string, unknown>;
  TAILSCALE_ATS_EXCEPTION: Record<string, unknown>;
  TAILSCALE_DOMAIN: string;
};

const devNetworkingPlugin = require('../../../plugins/with-boardsesh-dev-networking.js') as DevNetworkingPlugin;

describe('with-boardsesh-dev-networking', () => {
  it('adds a Tailscale MagicDNS ATS exception without enabling arbitrary loads', () => {
    const infoPlist = devNetworkingPlugin.applyBoardseshDevNetworkingInfoPlist({
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          'example.com': {
            NSIncludesSubdomains: true,
          },
        },
      },
    });

    expect(infoPlist.NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
      NSExceptionDomains: {
        'example.com': {
          NSIncludesSubdomains: true,
        },
        [devNetworkingPlugin.TAILSCALE_DOMAIN]: devNetworkingPlugin.TAILSCALE_ATS_EXCEPTION,
      },
    });
  });

  it('omits NSExceptionMinimumTLSVersion from the Tailscale exception', () => {
    expect(devNetworkingPlugin.TAILSCALE_ATS_EXCEPTION).not.toHaveProperty('NSExceptionMinimumTLSVersion');
  });

  it('preserves an upstream NSAllowsArbitraryLoads: true rather than clobbering it', () => {
    const infoPlist = devNetworkingPlugin.applyBoardseshDevNetworkingInfoPlist({
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
    });

    const ats = infoPlist.NSAppTransportSecurity as Record<string, unknown>;
    expect(ats.NSAllowsArbitraryLoads).toBe(true);
    expect(ats.NSAllowsLocalNetworking).toBe(true);
  });

  it('creates NSAppTransportSecurity when missing entirely', () => {
    const infoPlist = devNetworkingPlugin.applyBoardseshDevNetworkingInfoPlist({});

    expect(infoPlist.NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
      NSExceptionDomains: {
        [devNetworkingPlugin.TAILSCALE_DOMAIN]: devNetworkingPlugin.TAILSCALE_ATS_EXCEPTION,
      },
    });
  });

  it('replaces non-object NSAppTransportSecurity with a valid record', () => {
    const infoPlist = devNetworkingPlugin.applyBoardseshDevNetworkingInfoPlist({
      NSAppTransportSecurity: 'not an object',
    });

    const ats = infoPlist.NSAppTransportSecurity as Record<string, unknown>;
    expect(ats.NSExceptionDomains).toEqual({
      [devNetworkingPlugin.TAILSCALE_DOMAIN]: devNetworkingPlugin.TAILSCALE_ATS_EXCEPTION,
    });
  });

  it('preserves keys inside an existing ts.net exception that we do not set', () => {
    const infoPlist = devNetworkingPlugin.applyBoardseshDevNetworkingInfoPlist({
      NSAppTransportSecurity: {
        NSExceptionDomains: {
          'ts.net': {
            NSThirdPartyExceptionRequiresForwardSecrecy: false,
          },
        },
      },
    });

    const ats = infoPlist.NSAppTransportSecurity as { NSExceptionDomains: Record<string, Record<string, unknown>> };
    expect(ats.NSExceptionDomains['ts.net']).toEqual({
      NSThirdPartyExceptionRequiresForwardSecrecy: false,
      ...devNetworkingPlugin.TAILSCALE_ATS_EXCEPTION,
    });
  });
});
