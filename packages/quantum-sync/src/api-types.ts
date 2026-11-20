export type EwallsRecord = Readonly<Record<string, unknown>>;
export type EwallsIdentifiedRecord = EwallsRecord & { readonly id: string };
export type EwallsRouteReference = EwallsRecord & { readonly routeId: string };
export type EwallsScope = Readonly<{ board: string; forcedType: string }>;

export type EwallsChanges<T> = Readonly<{ upsert: readonly T[]; deleted: readonly string[] }>;

interface EwallsBatch {
  readonly scope: EwallsScope;
  readonly checkpoint: string;
  readonly routes: EwallsChanges<EwallsIdentifiedRecord>;
  readonly account: {
    readonly ascents: EwallsChanges<EwallsIdentifiedRecord>;
    readonly favorites: EwallsChanges<EwallsRouteReference>;
    readonly projects: EwallsChanges<EwallsRouteReference>;
  };
  /** Only a nonempty upstream diode collection replaces the cached collection. */
  readonly diodes: readonly EwallsRecord[] | null;
}

export interface EwallsBootstrap extends EwallsBatch {
  readonly kind: 'bootstrap';
  readonly baseCheckpoint: null;
}

export interface EwallsDelta extends EwallsBatch {
  readonly kind: 'delta';
  readonly baseCheckpoint: string;
}

export interface EwallsApiOptions {
  fetch?: typeof fetch;
  token?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTotalBytes?: number;
}
