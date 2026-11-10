/** Wire shapes for Connected apps (docs/integration-platform.md, "Connected apps"). */
export type ConnectedApp = {
  connectionId: string;
  /** The app's registered name, or null. */
  name: string | null;
  /** Who makes the app. Null until apps carry a publisher name. */
  publisherName: string | null;
  /** OAuth scope strings the climber allowed, such as `logbook:read`. */
  scopes: string[];
  /** ISO 8601. */
  connectedAt: string;
  /** ISO 8601, to within an hour, or null before the app's first API call. */
  lastUsedAt: string | null;
  /** True while Boardsesh has suspended the app. */
  suspended: boolean;
};

export type ConnectedApps = {
  apps: ConnectedApp[];
  /** False while partner apps are switched off on the server. */
  partnerAppsEnabled: boolean;
};
