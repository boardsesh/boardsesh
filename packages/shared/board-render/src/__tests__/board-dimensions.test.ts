// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import { BOARD_IMAGE_DIMENSIONS } from '@boardsesh/board-config';
import { describe, expect, it } from 'vitest';
import { MAX_RENDER_OUTPUT_PIXELS } from '../validation';

/**
 * Tripwire for the render route's pixel ceiling.
 *
 * A full-size render is the board image's own dimensions, so the ceiling has to
 * stay above the largest board art we ship. If a future board is taller than
 * this allows, that must surface as a red test here — not as a 400 for every
 * request for that board in production.
 */
describe('board art fits under the render pixel ceiling', () => {
  const boardImages = Object.entries(BOARD_IMAGE_DIMENSIONS).flatMap(([boardName, images]) =>
    Object.entries(images).map(([imageName, { width, height }]) => ({
      label: `${boardName}/${imageName}`,
      pixels: width * height,
      width,
      height,
    })),
  );

  it('covers every board image', () => {
    expect(boardImages.length).toBeGreaterThan(100);
  });

  it('leaves the largest board under MAX_RENDER_OUTPUT_PIXELS', () => {
    const largest = boardImages.reduce((worst, image) => (image.pixels > worst.pixels ? image : worst));

    expect(
      largest.pixels,
      `${largest.label} renders at ${largest.width}×${largest.height} (${largest.pixels} px), over the ` +
        `${MAX_RENDER_OUTPUT_PIXELS} px ceiling in validation.ts. Raise the ceiling (and the route's memory ` +
        'budget with it) rather than letting this board 400 in production.',
    ).toBeLessThan(MAX_RENDER_OUTPUT_PIXELS);
  });
});
