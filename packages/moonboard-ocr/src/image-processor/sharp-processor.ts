// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import sharp, { type Sharp } from 'sharp';
import path from 'path';
import type { ImageProcessor, RawPixelData, ImageMetadata, ImageRegion, NodeImageSource } from './types';

/**
 * Sharp-based image processor for Node.js environment.
 */
export class SharpImageProcessor implements ImageProcessor {
  private sharpInstance: Sharp | null = null;
  private imageBuffer: Buffer | null = null;
  private metadata: ImageMetadata | null = null;
  private sourceName: string = 'unknown';

  async load(source: NodeImageSource): Promise<void> {
    if (typeof source === 'string') {
      // File path
      this.sourceName = path.basename(source);
      this.sharpInstance = sharp(source);
      this.imageBuffer = await this.sharpInstance.clone().toBuffer();
    } else {
      // Buffer
      this.imageBuffer = source;
      this.sharpInstance = sharp(source);
    }

    const meta = await this.sharpInstance.metadata();
    if (!meta.width || !meta.height) {
      throw new Error('Could not read image dimensions');
    }
    this.metadata = { width: meta.width, height: meta.height };
  }

  getMetadata(): ImageMetadata {
    if (!this.metadata) throw new Error('Image not loaded');
    return this.metadata;
  }

  async extractRegion(region: ImageRegion): Promise<RawPixelData> {
    if (!this.imageBuffer) throw new Error('Image not loaded');

    const { data, info } = await sharp(this.imageBuffer)
      .extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height,
      })
      .ensureAlpha() // Convert RGB to RGBA for consistent 4-channel output
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data: new Uint8Array(data),
      width: info.width,
      height: info.height,
      channels: 4, // Always RGBA after ensureAlpha()
    };
  }

  async extractFullImage(): Promise<RawPixelData> {
    if (!this.imageBuffer) throw new Error('Image not loaded');

    const { data, info } = await sharp(this.imageBuffer)
      .ensureAlpha() // Convert RGB to RGBA for consistent 4-channel output
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data: new Uint8Array(data),
      width: info.width,
      height: info.height,
      channels: 4,
    };
  }

  async extractForOCR(region: ImageRegion): Promise<Buffer> {
    if (!this.imageBuffer) throw new Error('Image not loaded');

    return sharp(this.imageBuffer)
      .extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height,
      })
      .grayscale()
      .normalize()
      .toBuffer();
  }

  getSourceName(): string {
    return this.sourceName;
  }
}
