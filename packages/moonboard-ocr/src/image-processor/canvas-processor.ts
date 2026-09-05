// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import type { ImageProcessor, RawPixelData, ImageMetadata, ImageRegion, BrowserImageSource } from './types';

/**
 * Canvas-based image processor for browser environment.
 */
export class CanvasImageProcessor implements ImageProcessor {
  protected canvas: HTMLCanvasElement | null = null;
  protected ctx: CanvasRenderingContext2D | null = null;
  protected sourceName: string = 'unknown';

  async load(source: BrowserImageSource): Promise<void> {
    let imageBitmap: ImageBitmap;

    if (source instanceof File) {
      this.sourceName = source.name;
      imageBitmap = await createImageBitmap(source);
    } else if (source instanceof Blob) {
      imageBitmap = await createImageBitmap(source);
    } else if ('close' in source && typeof source.close === 'function') {
      // ImageBitmap
      imageBitmap = source;
    } else if (source instanceof HTMLImageElement) {
      imageBitmap = await createImageBitmap(source);
    } else {
      throw new Error('Unsupported image source type');
    }

    // Create canvas with image dimensions
    this.canvas = document.createElement('canvas');
    this.canvas.width = imageBitmap.width;
    this.canvas.height = imageBitmap.height;

    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new Error('Could not get canvas context');

    this.ctx.drawImage(imageBitmap, 0, 0);

    // Free memory if we created the ImageBitmap
    if (!(source instanceof File) || source instanceof Blob) {
      imageBitmap.close();
    }
  }

  getMetadata(): ImageMetadata {
    if (!this.canvas) throw new Error('Image not loaded');
    return { width: this.canvas.width, height: this.canvas.height };
  }

  async extractRegion(region: ImageRegion): Promise<RawPixelData> {
    if (!this.ctx) throw new Error('Image not loaded');

    const imageData = this.ctx.getImageData(region.x, region.y, region.width, region.height);

    return {
      data: imageData.data, // Uint8ClampedArray (RGBA)
      width: imageData.width,
      height: imageData.height,
      channels: 4, // Canvas is always RGBA
    };
  }

  async extractFullImage(): Promise<RawPixelData> {
    if (!this.ctx || !this.canvas) throw new Error('Image not loaded');

    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
      channels: 4,
    };
  }

  async extractForOCR(region: ImageRegion): Promise<ImageData> {
    if (!this.ctx) throw new Error('Image not loaded');

    const imageData = this.ctx.getImageData(region.x, region.y, region.width, region.height);

    // Convert to grayscale and normalize for better OCR
    // (matches Sharp's .grayscale().normalize() preprocessing)
    const data = imageData.data;

    // First pass: convert to grayscale and find min/max for normalization
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      if (gray < min) min = gray;
      if (gray > max) max = gray;
    }

    // Second pass: normalize to full 0-255 range
    const range = max - min || 1;
    for (let i = 0; i < data.length; i += 4) {
      const normalized = Math.round(((data[i] - min) / range) * 255);
      data[i] = normalized;
      data[i + 1] = normalized;
      data[i + 2] = normalized;
    }

    return imageData;
  }

  getSourceName(): string {
    return this.sourceName;
  }
}
