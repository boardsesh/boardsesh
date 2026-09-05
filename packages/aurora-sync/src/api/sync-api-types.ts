// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type User = {
  id: number;
  username: string;
  email_address: string;
  name: string | null;
  city: string | null;
  country: string | null;
  avatar_image: string | null;
  banner_image: string | null;
  height: number | null;
  wingspan: number | null;
  weight: number | null;
  instagram_username: string | null;
  is_public: boolean;
  is_listed: boolean;
  is_verified: boolean;
  created_at: string;
  updated_at: string;
  permissions: string[];
};

export type Wall = {
  uuid: string;
  name: string;
  user_id: number;
  product_id: number;
  is_adjustable: boolean;
  angle: number;
  layout_id: number;
  product_size_id: number;
  hsm: number;
  serial_number: string | null;
  set_ids: number[];
  is_listed: boolean;
  created_at: string;
  updated_at: string;
};

export type WallExpungement = {
  wall_uuid: string;
  created_at: string;
  updated_at: string;
};

export type Ascent = {
  uuid: string;
  wall_uuid: string | null;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  user_id: number;
  attempt_id: number;
  bid_count: number;
  quality: number;
  difficulty: number;
  is_benchmark: boolean;
  is_listed: boolean;
  comment: string;
  climbed_at: string;
  created_at: string;
  updated_at: string;
};

export type Bid = {
  uuid: string;
  wall_uuid: string | null;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  user_id: number;
  bid_count: number;
  comment: string;
  climbed_at: string;
  created_at: string;
  updated_at: string;
};

export type Tag = {
  entity_uuid: string;
  user_id: number;
  name: string;
  is_listed: boolean;
  created_at: string;
  updated_at: string;
};

export type Circuit = {
  uuid: string;
  user_id: number;
  name: string;
  description: string;
  color: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
};

export type UserSync = {
  user_id: number;
  table_name: string;
  last_synchronized_at: string;
};

export type Attempt = {
  id: number;
  position: number;
  name: string;
};

export type Product = {
  id: number;
  name: string;
  is_listed: boolean;
  password: string | null;
  min_count_in_frame: number;
  max_count_in_frame: number;
};

export type ProductSize = {
  id: number;
  product_id: number;
  edge_left: number;
  edge_right: number;
  edge_bottom: number;
  edge_top: number;
  name: string;
  description: string;
  image_filename: string | null;
  position: number;
  is_listed: boolean;
};

export type ClimbStats = {
  climb_uuid: string;
  angle: number;
  display_difficulty: number | null;
  benchmark_difficulty: number | null;
  ascensionist_count?: number | null;
  difficulty_average: number | null;
  quality_average: number | null;
  fa_username: string | null;
  fa_at: string | null;
};

export type Hole = {
  id: number;
  product_id: number;
  name: string;
  x: number;
  y: number;
  mirrored_hole_id: number | null;
  mirror_group: number;
};

export type Led = {
  id: number;
  product_size_id: number;
  hole_id: number;
  position: number;
};

export type Layout = {
  id: number;
  product_id: number;
  name: string;
  instagram_caption: string | null;
  is_mirrored: boolean;
  is_listed: boolean;
  password: string | null;
  created_at: string;
};

export type PlacementRole = {
  id: number;
  product_id: number;
  position: number;
  name: string;
  full_name: string;
  led_color: string;
  screen_color: string;
};

export type Set = {
  id: number;
  name: string;
  hsm: number;
};

export type ProductsAngle = {
  product_id: number;
  angle: number;
};

export type BetaLink = {
  climb_uuid: string;
  link: string;
  foreign_username: string | null;
  angle: number | null;
  thumbnail: string | null;
  is_listed: boolean;
  created_at: string;
};

export type ProductSizesLayoutsSet = {
  id: number;
  product_size_id: number;
  layout_id: number;
  set_id: number;
  image_filename: string | null;
  is_listed: boolean;
};

export type Placement = {
  id: number;
  layout_id: number;
  hole_id: number;
  set_id: number;
  default_placement_role_id: number | null;
};

export type Kit = {
  serial_number: string;
  name: string | null;
  is_autoconnect: boolean;
  is_listed: boolean;
  created_at: string;
  updated_at: string;
};

export type SharedSync = {
  table_name: string;
  last_synchronized_at: string;
};

export type SyncPutFields =
  | User
  | Wall
  | WallExpungement
  | Ascent
  | UserSync
  | Climb
  | ClimbStats
  | SharedSync
  | Attempt
  | Product
  | ProductSize
  | Hole
  | Led
  | Layout
  | PlacementRole
  | Set
  | ProductsAngle
  | BetaLink
  | ProductSizesLayoutsSet
  | Placement
  | Kit;

export type SyncDataPUT = {
  users: User[];
  walls: Wall[];
  wall_expungements: WallExpungement[];
  ascents: Ascent[];
  user_syncs: UserSync[];
  climbs: Climb[];
  climb_stats: ClimbStats[];
  shared_syncs: SharedSync[];
  attempts: Attempt[];
  products: Product[];
  product_sizes: ProductSize[];
  holes: Hole[];
  leds: Led[];
  layouts: Layout[];
  placement_roles: PlacementRole[];
  sets: Set[];
  products_angles: ProductsAngle[];
  beta_links: BetaLink[];
  product_sizes_layouts_sets: ProductSizesLayoutsSet[];
  placements: Placement[];
  kits: Kit[];
} & Record<string, Array<SyncPutFields>>;

export type Climb = {
  uuid: string;
  name: string;
  description: string;
  hsm: number;
  edge_left: number;
  edge_right: number;
  edge_bottom: number;
  edge_top: number;
  frames_count: number;
  frames_pace: number;
  frames: string;
  setter_id: number;
  setter_username: string;
  layout_id: number;
  is_draft: boolean;
  is_listed: boolean;
  created_at: string;
  updated_at: string;
  angle: number;
};

export type SyncData = {
  PUT?: SyncDataPUT;
  _complete?: boolean;
  climbs?: Climb[];
  climb_stats?: ClimbStats[];
  shared_syncs?: SharedSync[];
  user_syncs?: UserSync[];
  users?: User[];
  walls?: Wall[];
  wall_expungements?: WallExpungement[];
  ascents?: Ascent[];
  bids?: Bid[];
  tags?: Tag[];
  circuits?: Circuit[];
  attempts?: Attempt[];
  products?: Product[];
  product_sizes?: ProductSize[];
  holes?: Hole[];
  leds?: Led[];
  layouts?: Layout[];
  placement_roles?: PlacementRole[];
  sets?: Set[];
  products_angles?: ProductsAngle[];
  beta_links?: BetaLink[];
  product_sizes_layouts_sets?: ProductSizesLayoutsSet[];
  placements?: Placement[];
  kits?: Kit[];
} & Record<string, unknown>;
