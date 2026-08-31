import type { QuantumSyncContract } from './config';

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
  sig: string;
};

export type QuantumManifestChunk = {
  name: 'quantum_snapshot_v1';
  type: 'quantum';
  sha256: string;
  size: number;
  urls: readonly string[];
};

export type QuantumManifest = {
  v: 1;
  board: 'quantum';
  source: string;
  created_at: number;
  compression: 'zstd';
  chunks: readonly [QuantumManifestChunk];
};

export type QuantumManifestCandidate = {
  event: Readonly<NostrEvent>;
  manifest: Readonly<QuantumManifest>;
};

export type QuantumManifestSelection = QuantumManifestCandidate & {
  rejectedEventCount: number;
};

export type QuantumManifestQuery = {
  relays: readonly string[];
  signerPubkey: string;
  kind: number;
  dTag: string;
  maxManifestBytes: number;
  maxEventsPerRelay: number;
  relayTimeoutMs: number;
  signal?: AbortSignal;
};

export type LoadNostrEvents = (query: Readonly<QuantumManifestQuery>) => Promise<readonly unknown[]>;
export type VerifyNostrEventSignature = (event: Readonly<NostrEvent>) => boolean | Promise<boolean>;

export type QuantumMirrorFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type QuantumResolvedAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type QuantumHostnameResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly QuantumResolvedAddress[]>;

export type DownloadedQuantumChunk = {
  filePath: string;
  mirrorUrl: string;
  sha256: string;
  size: number;
  dispose(): Promise<void>;
};

export type ZstdStreamDecoder = (compressedFilePath: string, signal?: AbortSignal) => AsyncIterable<Uint8Array>;

export type QuantumModelCode = 'xl' | 'l' | 'm' | 's' | 'belay';

export type QuantumModelRow = Readonly<{
  model: QuantumModelCode;
  layoutId: number;
  productSizeId: number;
  name: string;
  columns: number;
  rows: number;
  forcedType: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
}>;

export type QuantumDiodeRow = Readonly<{
  model: QuantumModelCode;
  diodeUuid: string;
  placementId: number;
  ledNode: string;
  autocadId: number;
  holdType: string;
  x: number;
  y: number;
  z: number;
}>;

export type QuantumRouteRow = Readonly<{
  uuid: string;
  name: string;
  setter: string;
  grade: string;
  angle: number;
  rating: number;
  ascents: number;
  plays: number;
  createdAt: number;
  updatedAt: number;
  disabled: boolean;
  campusing: boolean;
  edge: boolean;
  kickplate: boolean;
  matching: boolean;
  standard: boolean;
  tags: string;
  tips: string;
}>;

/**
 * Rows as returned by SQLite before validation and normalization. The unions
 * intentionally reflect the v1 tables' declared SQLite affinities and their
 * lack of NOT NULL constraints. Import callbacks receive the narrower,
 * normalized row types above instead.
 */
export type QuantumSqliteModelRow = Readonly<{
  model: string | null;
  layout_id: number | null;
  product_size_id: number | null;
  name: string | null;
  columns: number | null;
  rows: number | null;
  forced_type: string | null;
  edge_left: number | null;
  edge_right: number | null;
  edge_bottom: number | null;
  edge_top: number | null;
}>;

export type QuantumSqliteDiodeRow = Readonly<{
  model: string | null;
  diode_uuid: string | null;
  placement_id: number | null;
  led_node: string | null;
  autocad_id: string | null;
  hold_type: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
}>;

export type QuantumSqliteRouteRow = Readonly<{
  uuid: string | null;
  name: string | null;
  setter: string | null;
  grade: string | null;
  angle: number | null;
  rating: number | null;
  ascents: number | null;
  plays: number | null;
  created_at: number | null;
  updated_at: number | null;
  disabled: number | null;
  campusing: number | null;
  edge: number | null;
  kickplate: number | null;
  matching: number | null;
  standard: number | null;
  tags: string | null;
  tips: string | null;
}>;

export type QuantumSqliteRouteModelRow = Readonly<{
  route_uuid: string | null;
  model: string | null;
  app_uuid: string | null;
}>;

export type QuantumSqliteRouteLightRow = Readonly<{
  route_uuid: string | null;
  model: string | null;
  diode_uuid: string | null;
  step: number | null;
}>;

export type QuantumRouteModelRow = Readonly<{
  routeUuid: string;
  model: QuantumModelCode;
  appUuid: string;
}>;

export type QuantumRouteLightRow = Readonly<{
  routeUuid: string;
  model: QuantumModelCode;
  diodeUuid: string;
  /** Source step: 1=start, 3=finish, every other byte value=hand. */
  step: number;
}>;

export type QuantumSnapshotRows = Readonly<{
  models: readonly QuantumModelRow[];
  diodes: readonly QuantumDiodeRow[];
  routes: readonly QuantumRouteRow[];
  routeModels: readonly QuantumRouteModelRow[];
  routeLights: readonly QuantumRouteLightRow[];
}>;

export type QuantumSnapshotValidationSummary = Readonly<{
  models: number;
  diodes: number;
  routes: number;
  routeModels: number;
  routeLights: number;
}>;

export type ValidatedQuantumSnapshot = Readonly<{
  eventId: string;
  eventPubkey: string;
  eventCreatedAt: number;
  dTag: string;
  board: 'quantum';
  /** Authenticated manifest label only; it is not independent proof of legal authorization. */
  source: string;
  manifestCreatedAt: number;
  chunkName: 'quantum_snapshot_v1';
  chunkSha256: string;
  compressedSize: number;
  decompressedSha256: string;
  decompressedSize: number;
  selectedMirrorUrl: string;
  rows: QuantumSnapshotRows;
  summary: QuantumSnapshotValidationSummary;
}>;

export type ImportValidatedQuantumSnapshot<Result = unknown> = (
  snapshot: ValidatedQuantumSnapshot,
  signal?: AbortSignal,
) => Promise<Result>;

export type QuantumSyncOnceResult<Result = unknown> = Readonly<{
  contract: QuantumSyncContract;
  snapshot: ValidatedQuantumSnapshot;
  importResult: Result;
  rejectedEventCount: number;
}>;
