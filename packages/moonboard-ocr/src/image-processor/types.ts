// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Represents raw pixel data from an image
 */
export type RawPixelData = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 4; // Always RGBA for consistency between Sharp and Canvas
};

/**
 * Image metadata
 */
export type ImageMetadata = {
  width: number;
  height: number;
};

/**
 * Region specification for cropping
 */
export type ImageRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Valid input sources for loading images in Node.js
 */
export type NodeImageSource = Buffer | string;

/**
 * Valid input sources for loading images in Browser
 */
export type BrowserImageSource = File | Blob | ImageBitmap | HTMLImageElement;

/**
 * All valid image sources
 */
export type ImageSource = NodeImageSource | BrowserImageSource;

/**
 * Abstraction layer for image processing operations.
 * Implemented by SharpImageProcessor (Node) and CanvasImageProcessor (Browser).
 */
export type ImageProcessor = {
  /**
   * Load image from various sources
   * - Node: Buffer, string path
   * - Browser: File, Blob, ImageBitmap, HTMLImageElement
   */
  load(source: ImageSource): Promise<void>;

  /**
   * Get image metadata (dimensions)
   */
  getMetadata(): ImageMetadata;

  /**
   * Extract raw pixel data from a region.
   * Returns RGBA data (4 channels) for consistency.
   */
  extractRegion(region: ImageRegion): Promise<RawPixelData>;

  /**
   * Extract raw pixel data from the full image.
   * Returns RGBA data (4 channels) for consistency.
   */
  extractFullImage(): Promise<RawPixelData>;

  /**
   * Extract a region as a format suitable for Tesseract.js
   * - Node: Returns Buffer (grayscale, normalized)
   * - Browser: Returns ImageData (grayscale)
   */
  extractForOCR(region: ImageRegion): Promise<Buffer | ImageData>;

  /**
   * Get the source file name (for metadata)
   */
  getSourceName(): string;
};
