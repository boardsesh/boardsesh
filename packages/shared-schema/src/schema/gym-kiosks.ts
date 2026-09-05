// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export const gymKiosksTypeDefs = /* GraphQL */ `
  # ============================================
  # Gym Kiosk Types (smart-TV wall dashboard)
  # ============================================

  """
  One resolved board shown on a kiosk, in slot order. These are the boards that
  actually render on the TV: dead/unlinked slots are dropped, and for a viewer
  without gym-edit access non-public boards are filtered out entirely (the kiosk
  client renders a placeholder for the missing slot / degrades the preset).
  \`boardId\` is the numeric board-presence channel id (userBoards.id) and is
  always populated here. Visibility follows the viewer's GYM-level access: a gym
  editor (owner, gym admin/editor, or covering community admin/leader) sees every
  alive gym-linked slot board — private included, so the manage UI never shows a
  placeholder for a board they just placed; everyone else gets only boards
  passing the same anon-readable gate as \`UserBoard.boardId\` (public, or the
  viewer can edit that board), which is exactly when that id is safe to expose.
  """
  type GymKioskBoard {
    "Numeric board-presence channel id (userBoards.id) — feeds boardNowPlaying(boardId)."
    boardId: Int!
    "The board's immutable UUID (stable across board renames)."
    boardUuid: ID!
    "Public URL slug (userBoards.slug) — the kiosk's per-board install QR deep-links to /b/{slug}."
    slug: String!
    "Board display name."
    name: String!
    "Board type (kilter, tension, moonboard, ...)."
    boardType: String!
    "Layout ID."
    layoutId: Int!
    "Product size ID."
    sizeId: Int!
    "Comma-separated set IDs."
    setIds: String!
    "Default wall angle."
    angle: Int!
  }

  """
  A gym kiosk: a preset-based smart-TV wall dashboard, addressed publicly as
  \`/kiosk/{gym-slug}/{kiosk-slug}\`. The \`layout\` is the stored preset config —
  1–4 board slots plus an optional leaderboard rail — validated on write against
  @boardsesh/kiosk's \`KioskLayoutSchema\` and read back leniently (a corrupt or
  future-version stored layout degrades to an empty layout rather than erroring).
  \`boards\` is the RESOLVED slot list (see GymKioskBoard); it can be shorter than
  \`layout.boards\` when slots point at dead boards or boards the viewer may not
  see. \`gym\` carries the gym's branding (logo + colours) for the kiosk chrome.
  """
  type GymKiosk {
    "Unique identifier."
    uuid: ID!
    "URL slug (unique per gym among live kiosks)."
    slug: String!
    "Kiosk display name."
    name: String!
    "Preset layout config (@boardsesh/kiosk KioskLayoutSchema): 1–4 board slots + optional leaderboard rail. Read leniently."
    layout: JSON!
    "The owning gym, enriched with branding for the kiosk chrome."
    gym: Gym!
    "Resolved slot boards in slot order (dead/hidden slots omitted)."
    boards: [GymKioskBoard!]!
    "When the kiosk was created (ISO 8601)."
    createdAt: String!
    "When the kiosk was last updated (ISO 8601)."
    updatedAt: String!
    """
    When a live TV last checked in (ISO 8601), or null when it never has — or its
    ephemeral signal has expired. Populated only on the edit-guarded \`gymKiosks\`
    query; the public \`gymKiosk\` read never exposes liveness. Backed by Redis
    with a generous TTL, so a null here means "no signal", never "definitely
    down".
    """
    lastSeenAt: String
  }

  """
  Input for creating a kiosk. \`slug\` is optional — when omitted it's derived
  from \`name\` and made unique within the gym. A kiosk can be created before the
  gym has a slug (the manage UI prompts for the gym slug the public kiosk URL
  needs); creation itself doesn't require one.
  """
  input CreateGymKioskInput {
    "The gym to create the kiosk under."
    gymUuid: ID!
    "Kiosk display name."
    name: String!
    "Optional URL slug (lowercase alphanumeric + hyphens, 3–60 chars). Derived from name when omitted."
    slug: String
  }

  """
  Input for updating a kiosk. Every field is optional; omitted fields are left
  untouched. When \`layout\` is present it's validated with the STRICT
  KioskLayoutSchema and every referenced board (slots + a single-board
  leaderboard) must be an alive board linked to this kiosk's gym.
  """
  input UpdateGymKioskInput {
    "The kiosk to update."
    kioskUuid: ID!
    "New display name."
    name: String
    "New URL slug (lowercase alphanumeric + hyphens, 3–60 chars; unique per gym)."
    slug: String
    "New preset layout config (@boardsesh/kiosk KioskLayoutSchema). Persisted as the schema-parsed output."
    layout: JSON
  }

  """
  Input for a kiosk check-in. Sent by the PUBLIC kiosk TV pages (unauthenticated)
  on load and on each config-poll tick so owners can see which screens are live.
  \`gymUuid\` scopes the ephemeral keyspace; both UUIDs are validated against a
  live kiosk before anything is recorded — nothing here is trusted beyond that
  lookup. \`viewportWidth\`/\`viewportHeight\` are an optional coarse client marker.
  """
  input KioskHeartbeatInput {
    "The kiosk that's checking in."
    kioskUuid: ID!
    "The gym the kiosk belongs to (keyspace scoping)."
    gymUuid: ID!
    "Optional viewport width in CSS pixels."
    viewportWidth: Int
    "Optional viewport height in CSS pixels."
    viewportHeight: Int
  }
`;
