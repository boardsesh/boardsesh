import { describe, expect, it } from 'vitest';
import {
  buildConnectedAppDetail,
  buildConnectedAppRow,
  buildConnectedAppsSection,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  orderConnectedAppScopes,
  withoutConnectedApp,
  type ConnectedAppFacts,
  type ConnectedAppsFormatters,
  type ConnectedAppsTranslate,
} from '../index';

/** Echoes the key and its options, so each test sees exactly what was asked for. */
const echo: ConnectedAppsTranslate = (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key);

const NOW = Date.parse('2026-11-10T12:00:00Z');
const formatters: ConnectedAppsFormatters = {
  date: (iso) => `date(${iso.slice(0, 10)})`,
  relativeTime: (iso) => `ago(${iso})`,
  nowMs: NOW,
};

function app(overrides: Partial<ConnectedAppFacts> = {}): ConnectedAppFacts {
  return {
    connectionId: 'connection-a',
    name: 'Hangboard Planner',
    publisherName: null,
    scopes: ['offline_access', 'logbook:read', 'profile:read'],
    connectedAt: '2026-10-12T08:00:00.000Z',
    lastUsedAt: '2026-11-10T09:00:00.000Z',
    suspended: false,
    ...overrides,
  };
}

describe('the section', () => {
  it.each([
    ['signed out', false, { apps: [app()], partnerAppsEnabled: true }],
    ['the first load still running or failed', true, undefined],
    ['no connections while partner apps are off', true, { apps: [], partnerAppsEnabled: false }],
  ])('is hidden when %s', (_label, signedIn, data) => {
    expect(buildConnectedAppsSection({ signedIn, data, t: echo, formatters })).toEqual({ kind: 'hidden' });
  });

  it('says so when partner apps are on and nothing is connected', () => {
    expect(
      buildConnectedAppsSection({ signedIn: true, data: { apps: [], partnerAppsEnabled: true }, t: echo, formatters }),
    ).toEqual({
      kind: 'empty',
      title: 'settings:integrations.partnerApps.title',
      message: 'settings:integrations.partnerApps.empty',
    });
  });

  it('lists a connection made before partner apps were switched off, so it can still be disconnected', () => {
    const section = buildConnectedAppsSection({
      signedIn: true,
      data: { apps: [app()], partnerAppsEnabled: false },
      t: echo,
      formatters,
    });
    expect(section.kind).toBe('list');
  });

  it('keeps the server order', () => {
    const section = buildConnectedAppsSection({
      signedIn: true,
      data: { apps: [app({ connectionId: 'newer' }), app({ connectionId: 'older' })], partnerAppsEnabled: true },
      t: echo,
      formatters,
    });
    if (section.kind !== 'list') throw new Error(`expected a list, got ${section.kind}`);
    expect(section.rows.map((row) => row.connectionId)).toEqual(['newer', 'older']);
  });
});

describe('a row', () => {
  it('names the app, what it reads, when it connected and when it was last used', () => {
    expect(buildConnectedAppRow(app(), echo, formatters)).toEqual({
      connectionId: 'connection-a',
      name: 'Hangboard Planner',
      publisher: null,
      scopes: [
        {
          scope: 'logbook:read',
          label: 'settings:integrations.partnerApps.scopes.logbookRead',
          notes: [
            'settings:integrations.partnerApps.scopes.logbookOnlyMe',
            'settings:integrations.partnerApps.scopes.logbookUnlisted',
            'settings:integrations.partnerApps.scopes.logbookSpraywall',
          ],
        },
        { scope: 'profile:read', label: 'settings:integrations.partnerApps.scopes.profileRead', notes: [] },
        { scope: 'offline_access', label: 'settings:integrations.partnerApps.scopes.offlineAccess', notes: [] },
      ],
      connected: 'settings:integrations.partnerApps.connected {"date":"date(2026-10-12)"}',
      lastUsed: 'settings:integrations.partnerApps.lastUsed {"time":"ago(2026-11-10T09:00:00.000Z)"}',
      summary: 'settings:integrations.partnerApps.lastUsed {"time":"ago(2026-11-10T09:00:00.000Z)"}',
      suspendedNotice: null,
      disconnectLabel: 'settings:integrations.partnerApps.disconnect',
      disconnectAccessibilityLabel: 'settings:integrations.partnerApps.disconnectA11y {"app":"Hangboard Planner"}',
    });
  });

  it.each([
    ['never used', null, 'settings:integrations.partnerApps.notUsedYet'],
    ['an unreadable time', 'not a date', 'settings:integrations.partnerApps.notUsedYet'],
    ['used 10 minutes ago', '2026-11-10T11:50:00.000Z', 'settings:integrations.partnerApps.lastUsedRecently'],
    ['used 59 minutes ago', '2026-11-10T11:01:00.000Z', 'settings:integrations.partnerApps.lastUsedRecently'],
    [
      'used an hour ago',
      '2026-11-10T11:00:00.000Z',
      'settings:integrations.partnerApps.lastUsed {"time":"ago(2026-11-10T11:00:00.000Z)"}',
    ],
  ])('reads %s as %s', (_label, lastUsedAt, expected) => {
    expect(buildConnectedAppRow(app({ lastUsedAt }), echo, formatters).lastUsed).toBe(expected);
  });

  it.each([[null], [''], ['   ']])('calls an app named %j "Unnamed app"', (name) => {
    const row = buildConnectedAppRow(app({ name }), echo, formatters);
    expect(row.name).toBe('settings:integrations.partnerApps.unnamedApp');
    expect(row.disconnectAccessibilityLabel).toContain('settings:integrations.partnerApps.unnamedApp');
  });

  it('shows the publisher once apps carry one', () => {
    expect(buildConnectedAppRow(app({ publisherName: ' Sequence Labs ' }), echo, formatters).publisher).toBe(
      'settings:integrations.partnerApps.publisher {"publisher":"Sequence Labs"}',
    );
    expect(buildConnectedAppRow(app({ publisherName: '  ' }), echo, formatters).publisher).toBeNull();
  });

  it('explains a suspended app, and says so in the list row', () => {
    const row = buildConnectedAppRow(app({ suspended: true }), echo, formatters);
    expect(row.suspendedNotice).toBe('settings:integrations.partnerApps.suspended');
    expect(row.summary).toBe('settings:integrations.partnerApps.suspendedShort');
  });

  it('words a scope it does not know rather than hiding it', () => {
    const [scope] = buildConnectedAppRow(app({ scopes: ['workouts:write'] }), echo, formatters).scopes;
    expect(scope).toEqual({
      scope: 'workouts:write',
      label: 'settings:integrations.partnerApps.scopes.other {"scope":"workouts:write"}',
      notes: [],
    });
  });
});

describe('scope order', () => {
  it('puts the logbook first, keeping access last, newer scopes after, each once', () => {
    expect(
      orderConnectedAppScopes([
        'offline_access',
        'zeta:read',
        'profile:read',
        'alpha:read',
        'logbook:read',
        'profile:read',
      ]),
    ).toEqual(['logbook:read', 'profile:read', 'offline_access', 'alpha:read', 'zeta:read']);
  });
});

describe('Disconnect', () => {
  it('asks first, naming the app and what it keeps', () => {
    expect(connectedAppDisconnectPrompt({ name: 'DivePeaks' }, echo)).toEqual({
      title: 'settings:integrations.partnerApps.disconnectConfirmTitle {"app":"DivePeaks"}',
      message: 'settings:integrations.partnerApps.disconnectConfirmBody {"app":"DivePeaks"}',
      confirmLabel: 'settings:integrations.partnerApps.disconnect',
      cancelLabel: 'settings:integrations.partnerApps.cancel',
    });
  });

  it('reports either outcome by name', () => {
    expect(connectedAppDisconnectResult({ name: 'DivePeaks' }, 'disconnected', echo)).toBe(
      'settings:integrations.partnerApps.disconnected {"app":"DivePeaks"}',
    );
    expect(connectedAppDisconnectResult({ name: null }, 'failed', echo)).toBe(
      'settings:integrations.partnerApps.disconnectFailed {"app":"settings:integrations.partnerApps.unnamedApp"}',
    );
  });

  it('drops only the disconnected row', () => {
    const data = { apps: [app({ connectionId: 'a' }), app({ connectionId: 'b' })], partnerAppsEnabled: false };
    expect(withoutConnectedApp(data, 'a')).toEqual({ apps: [app({ connectionId: 'b' })], partnerAppsEnabled: false });
    expect(data.apps).toHaveLength(2);
  });
});

describe('the detail', () => {
  const data = {
    apps: [app({ connectionId: 'a' }), app({ connectionId: 'b', name: 'DivePeaks' })],
    partnerAppsEnabled: true,
  };

  it('waits for the list the first time', () => {
    expect(
      buildConnectedAppDetail({ signedIn: true, data: undefined, connectionId: 'a', t: echo, formatters }),
    ).toEqual({
      kind: 'loading',
    });
  });

  it('offers a retry, never an endless spinner, when the first load failed', () => {
    expect(
      buildConnectedAppDetail({
        signedIn: true,
        data: undefined,
        connectionId: 'a',
        loadFailed: true,
        t: echo,
        formatters,
      }),
    ).toEqual({
      kind: 'error',
      message: 'settings:integrations.partnerApps.loadFailed',
      retryLabel: 'settings:integrations.partnerApps.retry',
    });
  });

  it('shows the app the row named, with what it can see and what Disconnect does', () => {
    const detail = buildConnectedAppDetail({ signedIn: true, data, connectionId: 'b', t: echo, formatters });
    if (detail.kind !== 'app') throw new Error(`expected the app, got ${detail.kind}`);
    expect(detail.row.name).toBe('DivePeaks');
    expect(detail.scopesHeading).toBe('settings:integrations.partnerApps.scopesHeading {"app":"DivePeaks"}');
    expect(detail.footer).toBe('settings:integrations.partnerApps.footer');
  });

  it.each([
    ['an app no longer connected', true, 'gone-id'],
    ['signed out', false, 'a'],
  ])('says the app is gone for %s', (_label, signedIn, connectionId) => {
    expect(buildConnectedAppDetail({ signedIn, data, connectionId, t: echo, formatters })).toEqual({
      kind: 'gone',
      message: 'settings:integrations.partnerApps.gone',
    });
  });
});
