// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Browser entry point for @boardsesh/moonboard-ocr
 *
 * This module provides a Canvas-based implementation that works in browsers.
 * It accepts File or Blob objects from file inputs or drag-and-drop.
 *
 * @example
 * ```typescript
 * import { parseScreenshot } from '@boardsesh/moonboard-ocr/browser';
 *
 * // From file input
 * const fileInput = document.querySelector('input[type="file"]');
 * fileInput.addEventListener('change', async (e) => {
 *   const file = e.target.files[0];
 *   const result = await parseScreenshot(file);
 *   if (result.success) {
 *     console.log('Climb:', result.climb);
 *   }
 * });
 * ```
 */

import { CanvasImageProcessor } from './image-processor/canvas-processor';
// Import from parser-core to avoid pulling in sharp via parser.ts
import { parseWithProcessor, deduplicateClimbs } from './parser-core';
import type { ParseResult, MoonBoardClimb, DetectedHold, GridCoordinate, HoldType } from './types';

// Re-export types for consumers
export type { ParseResult, MoonBoardClimb, DetectedHold, GridCoordinate, HoldType };

/**
 * Parse a MoonBoard screenshot from a File or Blob (Browser API)
 *
 * @param image - A File or Blob containing the screenshot image
 * @returns ParseResult containing the extracted climb data or error
 */
export async function parseScreenshot(image: File | Blob): Promise<ParseResult> {
  const processor = new CanvasImageProcessor();
  await processor.load(image);
  return parseWithProcessor(processor);
}

/**
 * Parse multiple images and return all successful parses
 *
 * @param images - Array of File or Blob objects
 * @param onProgress - Optional callback for progress updates
 * @returns Object with successful climbs and any errors
 */
export async function parseMultipleScreenshots(
  images: Array<File | Blob>,
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<{ climbs: MoonBoardClimb[]; errors: Array<{ name: string; error: string }> }> {
  const climbs: MoonBoardClimb[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const name = image instanceof File ? image.name : `image-${i}`;
    onProgress?.(i + 1, images.length, name);

    try {
      const result = await parseScreenshot(image);
      if (result.success && result.climb) {
        climbs.push(result.climb);
      } else {
        errors.push({ name, error: result.error || 'Unknown error' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push({ name, error: message });
    }
  }

  return { climbs, errors };
}

// Re-export deduplicateClimbs (pure function, works in browser)
export { deduplicateClimbs };

// Re-export the CanvasImageProcessor for advanced use cases
export { CanvasImageProcessor } from './image-processor/canvas-processor';
export { parseWithProcessor } from './parser-core';
export type { ImageProcessor, RawPixelData, ImageMetadata, ImageRegion } from './image-processor/types';
