export type QuantumModelCode = 'xl' | 'l' | 'm' | 's' | 'belay';

export type QuantumModelRow = Readonly<{
  model: QuantumModelCode;
  /** Boardsesh physical layout id; XL, L and M share one layout. */
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

export type QuantumCatalogRows = Readonly<{
  models: readonly QuantumModelRow[];
  diodes: readonly QuantumDiodeRow[];
  routes: readonly QuantumRouteRow[];
  routeModels: readonly QuantumRouteModelRow[];
  routeLights: readonly QuantumRouteLightRow[];
}>;
