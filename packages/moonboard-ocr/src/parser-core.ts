/**
 * Core parsing functions that work in both Node.js and browser environments.
 * This module does NOT import sharp or any Node.js-specific modules.
 *
 * For Node.js-specific functions (that use file paths), see parser.ts
 */

import type { ImageProcessor } from './image-processor/types';
import { runOCR, type OcrOptions } from './core/ocr';
import { detectHoldsFromPixelData, detectBoardRegion, detectBenchmarkCircle } from './core/holds';
import { calculateRegions, calculateRegionsFromDetectedBoard, calculateAndroidRegions } from './core/regions';
import { boardRows, type HoldSetup } from './board-profiles';
import type { MoonBoardClimb, ParseResult, GridCoordinate } from './types';

export type ParseOptions = OcrOptions & {
  /** Upstream setup ID. Defaults to the original full-size 2024 parser. */
  holdsetup?: HoldSetup;
  /** Explicitly opt into calibrated Android geometry; legacy iOS remains default. */
  screenshotProfile?: 'legacy-ios' | 'android-pixel8pro-1.3.68';
};

/**
 * Parse a MoonBoard screenshot using the provided ImageProcessor.
 * This is the core parsing function used by both Node and browser implementations.
 *
 * Uses yellow-pixel auto-detection to find the board region, making it resilient
 * to different iPhone screen sizes. Falls back to proportional calculation if
 * auto-detection fails.
 */
export async function parseWithProcessor(processor: ImageProcessor, options: ParseOptions = {}): Promise<ParseResult> {
  const warnings: string[] = [];

  try {
    const metadata = processor.getMetadata();
    const rows = boardRows(options.holdsetup);
    const android = options.screenshotProfile === 'android-pixel8pro-1.3.68';
    if (options.screenshotProfile && !android && options.screenshotProfile !== 'legacy-ios') {
      throw new Error('Unsupported screenshot profile');
    }
    if (rows === 12 && !android) throw new Error('Mini screenshots require a validated Android profile');
    if (!android && options.holdsetup !== undefined && options.holdsetup !== 21) {
      throw new Error('This setup requires a validated Android screenshot profile');
    }

    // Try auto-detecting the board via yellow pixel analysis
    const fullPixelData = await processor.extractFullImage();
    const yellowRegion = detectBoardRegion(fullPixelData);

    const regions = android
      ? calculateAndroidRegions(metadata.width, metadata.height, rows)
      : yellowRegion
        ? calculateRegionsFromDetectedBoard(yellowRegion, metadata.width, metadata.height)
        : (() => {
            warnings.push('Could not auto-detect board region, using proportional fallback');
            return calculateRegions(metadata.width, metadata.height);
          })();

    // Extract header for OCR and benchmark detection
    const headerPixels = await processor.extractRegion(regions.header);
    const isBenchmark = detectBenchmarkCircle(headerPixels, android ? 'android' : 'legacy-ios');

    const ocrImageData = await processor.extractForOCR(regions.header);
    const ocrResult = await runOCR(ocrImageData, options);
    warnings.push(...ocrResult.warnings);

    // Extract board region for hold detection
    const boardPixels = await processor.extractRegion(regions.board);
    const detectedHolds = detectHoldsFromPixelData(boardPixels, regions.board, rows, android ? 'android' : 'combined');

    // Group holds by type
    const startHolds: GridCoordinate[] = [];
    const handHolds: GridCoordinate[] = [];
    const finishHolds: GridCoordinate[] = [];

    for (const hold of detectedHolds) {
      switch (hold.type) {
        case 'start':
          startHolds.push(hold.coordinate);
          break;
        case 'hand':
          handHolds.push(hold.coordinate);
          break;
        case 'finish':
          finishHolds.push(hold.coordinate);
          break;
      }
    }

    // Validate we found some holds
    if (startHolds.length === 0) {
      warnings.push('No start holds detected');
    }
    if (finishHolds.length === 0) {
      warnings.push('No finish holds detected');
    }
    if (startHolds.length + handHolds.length + finishHolds.length === 0) {
      return { success: false, error: 'No holds detected in image', warnings };
    }

    // Build the climb object
    const climb: MoonBoardClimb = {
      name: ocrResult.name,
      setter: ocrResult.setter,
      angle: ocrResult.angle,
      userGrade: ocrResult.userGrade,
      setterGrade: ocrResult.setterGrade,
      isBenchmark: isBenchmark || ocrResult.isBenchmark,
      holds: {
        start: [...new Set(startHolds)], // Dedupe
        hand: [...new Set(handHolds)],
        finish: [...new Set(finishHolds)],
      },
      sourceFile: processor.getSourceName(),
      parseWarnings: warnings.length > 0 ? warnings : undefined,
    };

    return { success: true, climb, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `Failed to parse image: ${message}`, warnings };
  }
}

/**
 * Deduplicate climbs by their hold configuration
 * Two climbs with the same holds are considered the same climb
 */
export function deduplicateClimbs(climbs: MoonBoardClimb[]): MoonBoardClimb[] {
  const seen = new Map<string, MoonBoardClimb>();

  for (const climb of climbs) {
    // Create a unique key from sorted hold positions
    const key = [...climb.holds.start.sort(), '|', ...climb.holds.hand.sort(), '|', ...climb.holds.finish.sort()].join(
      ',',
    );

    // Keep the first occurrence (or could prefer one with better OCR results)
    if (!seen.has(key)) {
      seen.set(key, climb);
    }
  }

  return Array.from(seen.values());
}
