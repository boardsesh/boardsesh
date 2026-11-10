// Connected apps (#6981 F16, #7387): what a climber's settings say about the
// apps they connected through partner OAuth. One pure model for web and
// mobile; each platform only draws it. The caller hands in its i18next `t`
// (any namespace: every key here names `settings:` itself) and its own date
// formatters, so mobile's screenshot clock and each platform's locale apply.
// Every key is a literal so the orphan check sees it.

/** i18next's `t`. Keys carry their namespace. */
export type ConnectedAppsTranslate = (key: string, options?: Record<string, unknown>) => string;

/** One connection as the server sends it (`ConnectedApp` in `@boardsesh/shared-schema`). */
export interface ConnectedAppFacts {
  connectionId: string;
  name: string | null;
  publisherName: string | null;
  scopes: readonly string[];
  /** ISO 8601. */
  connectedAt: string;
  /** ISO 8601, to within an hour, or null before the app's first API call. */
  lastUsedAt: string | null;
  suspended: boolean;
}

/** `myConnectedApps` as the server sends it. */
export interface ConnectedAppsFacts {
  apps: readonly ConnectedAppFacts[];
  partnerAppsEnabled: boolean;
}

export interface ConnectedAppsFormatters {
  /** A calendar date in the climber's language, such as "12 Oct 2026". */
  date: (iso: string) => string;
  /** A distance in time in the climber's language, such as "3 hours ago". */
  relativeTime: (iso: string) => string;
  /** The platform's now, in epoch ms. Mobile passes its screenshot clock. */
  nowMs: number;
}

/** One thing an app can do, with the fine print a climber should see beside it. */
export interface ConnectedAppScopeView {
  scope: string;
  label: string;
  notes: string[];
}

export interface ConnectedAppRowView {
  connectionId: string;
  /** The app's name, or the word for an app without one. */
  name: string;
  /** "By …", or null while apps carry no publisher name. */
  publisher: string | null;
  scopes: ConnectedAppScopeView[];
  /** "Connected 12 Oct 2026". */
  connected: string;
  /** "Last used 3 hours ago", "Used in the last hour" or "Not used yet". */
  lastUsed: string;
  /** Set while Boardsesh has suspended the app. */
  suspendedNotice: string | null;
  disconnectLabel: string;
  /** "Disconnect Hangboard Planner", for a screen reader. */
  disconnectAccessibilityLabel: string;
}

/**
 * What the section shows:
 * - `hidden`: nothing at all. Signed out, still loading the first time, a
 *   failed first load, or no connections while partner apps are switched off.
 * - `empty`: no connections, with partner apps on.
 * - `list`: one row per connection, most recently connected first.
 */
export type ConnectedAppsSectionView =
  | { kind: 'hidden' }
  | { kind: 'empty'; title: string; message: string }
  | { kind: 'list'; title: string; rows: ConnectedAppRowView[]; footer: string };

export interface ConnectedAppsSectionInput {
  signedIn: boolean;
  /** Undefined until the first answer arrives, and after a failed first load. */
  data: ConnectedAppsFacts | undefined;
  t: ConnectedAppsTranslate;
  formatters: ConnectedAppsFormatters;
}

/** The section's order: what an app reads from the logbook leads, keeping access goes last. */
const SCOPE_ORDER = ['logbook:read', 'profile:read', 'offline_access'];

/** Connected apps' "last used" is written at most once an hour, so anything newer reads as this hour. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

function scopeRank(scope: string): number {
  const rank = SCOPE_ORDER.indexOf(scope);
  return rank === -1 ? SCOPE_ORDER.length : rank;
}

/** Known scopes in a fixed order, then any newer ones by name, each once. */
export function orderConnectedAppScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort((left, right) => scopeRank(left) - scopeRank(right) || left.localeCompare(right));
}

/**
 * One line per scope. `logbook:read` carries the two things a climber would not
 * guess: it includes ticks they keep to "Only me" (decision 21), and the full
 * climb behind every tick, unlisted climbs and drafts set by others included
 * (#7387, owner decision 2026-11-10).
 */
export function describeConnectedAppScope(scope: string, t: ConnectedAppsTranslate): ConnectedAppScopeView {
  switch (scope) {
    case 'logbook:read':
      return {
        scope,
        label: t('settings:integrations.partnerApps.scopes.logbookRead'),
        notes: [
          t('settings:integrations.partnerApps.scopes.logbookOnlyMe'),
          t('settings:integrations.partnerApps.scopes.logbookUnlisted'),
        ],
      };
    case 'profile:read':
      return { scope, label: t('settings:integrations.partnerApps.scopes.profileRead'), notes: [] };
    case 'offline_access':
      return { scope, label: t('settings:integrations.partnerApps.scopes.offlineAccess'), notes: [] };
    default:
      return { scope, label: t('settings:integrations.partnerApps.scopes.other', { scope }), notes: [] };
  }
}

/** The app's name as the climber sees it everywhere: trimmed, or "Unnamed app". */
export function connectedAppName(app: Pick<ConnectedAppFacts, 'name'>, t: ConnectedAppsTranslate): string {
  return app.name?.trim() || t('settings:integrations.partnerApps.unnamedApp');
}

function lastUsedLine(
  lastUsedAt: string | null,
  formatters: ConnectedAppsFormatters,
  t: ConnectedAppsTranslate,
): string {
  if (!lastUsedAt) return t('settings:integrations.partnerApps.notUsedYet');
  const usedAtMs = Date.parse(lastUsedAt);
  if (!Number.isFinite(usedAtMs)) return t('settings:integrations.partnerApps.notUsedYet');
  if (formatters.nowMs - usedAtMs < LAST_USED_RESOLUTION_MS) {
    return t('settings:integrations.partnerApps.lastUsedRecently');
  }
  return t('settings:integrations.partnerApps.lastUsed', { time: formatters.relativeTime(lastUsedAt) });
}

export function buildConnectedAppRow(
  app: ConnectedAppFacts,
  t: ConnectedAppsTranslate,
  formatters: ConnectedAppsFormatters,
): ConnectedAppRowView {
  const name = connectedAppName(app, t);
  const publisher = app.publisherName?.trim();
  return {
    connectionId: app.connectionId,
    name,
    publisher: publisher ? t('settings:integrations.partnerApps.publisher', { publisher }) : null,
    scopes: orderConnectedAppScopes(app.scopes).map((scope) => describeConnectedAppScope(scope, t)),
    connected: t('settings:integrations.partnerApps.connected', { date: formatters.date(app.connectedAt) }),
    lastUsed: lastUsedLine(app.lastUsedAt, formatters, t),
    suspendedNotice: app.suspended ? t('settings:integrations.partnerApps.suspended') : null,
    disconnectLabel: t('settings:integrations.partnerApps.disconnect'),
    disconnectAccessibilityLabel: t('settings:integrations.partnerApps.disconnectA11y', { app: name }),
  };
}

/**
 * The whole section. Hidden rather than empty while partner apps are off: with
 * no app able to connect, an empty "Apps with access" block only raises the
 * question of how to fill it. A climber who connected an app before the switch
 * still sees it and can disconnect it. A failed first load hides the section
 * too, so an older server or a dropped request never shows an error for a list
 * most climbers have never filled; once loaded, a failed refresh keeps the
 * last list.
 */
export function buildConnectedAppsSection({
  signedIn,
  data,
  t,
  formatters,
}: ConnectedAppsSectionInput): ConnectedAppsSectionView {
  if (!signedIn || !data) return { kind: 'hidden' };
  const title = t('settings:integrations.partnerApps.title');
  if (data.apps.length === 0) {
    if (!data.partnerAppsEnabled) return { kind: 'hidden' };
    return { kind: 'empty', title, message: t('settings:integrations.partnerApps.empty') };
  }
  return {
    kind: 'list',
    title,
    rows: data.apps.map((app) => buildConnectedAppRow(app, t, formatters)),
    footer: t('settings:integrations.partnerApps.footer'),
  };
}

export interface ConnectedAppDisconnectPrompt {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** The confirmation before Disconnect: what stops, and what the app keeps. */
export function connectedAppDisconnectPrompt(
  app: Pick<ConnectedAppFacts, 'name'>,
  t: ConnectedAppsTranslate,
): ConnectedAppDisconnectPrompt {
  const name = connectedAppName(app, t);
  return {
    title: t('settings:integrations.partnerApps.disconnectConfirmTitle', { app: name }),
    message: t('settings:integrations.partnerApps.disconnectConfirmBody', { app: name }),
    confirmLabel: t('settings:integrations.partnerApps.disconnect'),
    cancelLabel: t('settings:integrations.partnerApps.cancel'),
  };
}

/** The toast after Disconnect answers. */
export function connectedAppDisconnectResult(
  app: Pick<ConnectedAppFacts, 'name'>,
  outcome: 'disconnected' | 'failed',
  t: ConnectedAppsTranslate,
): string {
  const name = connectedAppName(app, t);
  return outcome === 'disconnected'
    ? t('settings:integrations.partnerApps.disconnected', { app: name })
    : t('settings:integrations.partnerApps.disconnectFailed', { app: name });
}

/** The list without one connection: what both platforms show the moment Disconnect succeeds. */
export function withoutConnectedApp<Facts extends ConnectedAppsFacts>(data: Facts, connectionId: string): Facts {
  return { ...data, apps: data.apps.filter((app) => app.connectionId !== connectionId) };
}
