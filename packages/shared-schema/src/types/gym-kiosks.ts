// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Gym kiosk (smart-TV wall dashboard) entity types.

import type { Gym } from './gyms';

/**
 * One resolved board on a kiosk, in slot order. `boardId` is always present
 * here because a board only makes it into the resolved list when its
 * presence-channel id is safe to expose (public, or the viewer can edit it).
 */
export type GymKioskBoard = {
  boardId: number;
  boardUuid: string;
  /** Public URL slug (userBoards.slug) — the kiosk's per-board install QR deep-links to /b/{slug}. */
  slug: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

/**
 * A gym kiosk. `layout` is intentionally typed `unknown` (the JSON scalar):
 * stored layouts are read leniently, so consumers must parse with
 * `parseKioskLayoutLenient` from @boardsesh/kiosk rather than trust the shape.
 */
export type GymKiosk = {
  uuid: string;
  slug: string;
  name: string;
  layout: unknown;
  gym: Gym;
  boards: GymKioskBoard[];
  createdAt: string;
  updatedAt: string;
  /**
   * When a live TV last checked in (ISO 8601), or null when it never has / its
   * ephemeral Redis signal has expired. Populated only on the edit-guarded
   * `gymKiosks` query — a null means "no signal", never "definitely down".
   */
  lastSeenAt: string | null;
};

export type CreateGymKioskInput = {
  gymUuid: string;
  name: string;
  slug?: string;
};

export type UpdateGymKioskInput = {
  kioskUuid: string;
  name?: string;
  slug?: string;
  layout?: unknown;
};

export type KioskHeartbeatInput = {
  kioskUuid: string;
  gymUuid: string;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
};
