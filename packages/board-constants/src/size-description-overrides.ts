// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Spelling corrections applied to Aurora's product-size descriptions.
 *
 * Aurora's own catalogue carries the typo — `board_product_sizes` (board_type
 * 'kilter', id 7, "12 x 14") stores `description = 'Commerical'`, and their app
 * shows it that way too. So this is a deliberate divergence from upstream, not a
 * bug in the generator, which copies the column faithfully.
 *
 * The correction is applied where the data is WRITTEN — the board-constants
 * generator — not where it is read. Fixing it in the database instead would not
 * hold: `upsertProductSizes` in `@boardsesh/aurora-sync` re-writes `description`
 * from Aurora on every catalog sync, so a migration would be reverted the next
 * time the catalogue syncs.
 *
 * Keys match the WHOLE trimmed description, not a word-level regex, so the map
 * stays narrow and auditable. As of 2026-08 this is the only misspelling in the
 * upstream catalogue: all 43 `board_product_sizes` rows, 16 `board_layouts`
 * names and 44 `board_sets` names were checked.
 *
 * See issue #4554.
 */
export const SIZE_DESCRIPTION_CORRECTIONS: Readonly<Record<string, string>> = {
  Commerical: 'Commercial',
};

/**
 * The description to store for a size, with any known upstream typo corrected.
 * Unknown descriptions pass through untouched.
 */
export function normalizeSizeDescription(description: string): string {
  return SIZE_DESCRIPTION_CORRECTIONS[description] ?? description;
}
