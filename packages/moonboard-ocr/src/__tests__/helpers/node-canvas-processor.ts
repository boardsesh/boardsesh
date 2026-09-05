// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Node-canvas based ImageProcessor for testing the Canvas implementation in Node.js.
 * This uses the `canvas` npm package to provide Canvas API in Node.js environment.
 */

import { type Canvas, type CanvasRenderingContext2D, createCanvas, loadImage } from 'canvas';
import fs from 'fs/promises';
import path from 'path';
import type { ImageProcessor, RawPixelData, ImageMetadata, ImageRegion } from '../../image-processor/types';

/**
 * Node-canvas implementation of ImageProcessor for testing.
 * Mimics the browser CanvasImageProcessor but uses node-canvas.
 */
export class NodeCanvasImageProcessor implements ImageProcessor {
  private canvas: Canvas | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private sourceName: string = 'unknown';

  async load(source: string | Buffer): Promise<void> {
    let buffer: Buffer;

    if (typeof source === 'string') {
      // File path
      this.sourceName = path.basename(source);
      buffer = await fs.readFile(source);
    } else {
      // Buffer
      buffer = source;
    }

    const image = await loadImage(buffer);

    // Create canvas with image dimensions
    this.canvas = createCanvas(image.width, image.height);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.drawImage(image, 0, 0);
  }

  getMetadata(): ImageMetadata {
    if (!this.canvas) throw new Error('Image not loaded');
    return { width: this.canvas.width, height: this.canvas.height };
  }

  async extractRegion(region: ImageRegion): Promise<RawPixelData> {
    if (!this.ctx) throw new Error('Image not loaded');

    const imageData = this.ctx.getImageData(region.x, region.y, region.width, region.height);

    return {
      data: new Uint8ClampedArray(imageData.data),
      width: imageData.width,
      height: imageData.height,
      channels: 4, // Canvas is always RGBA
    };
  }

  async extractFullImage(): Promise<RawPixelData> {
    if (!this.ctx || !this.canvas) throw new Error('Image not loaded');

    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

    return {
      data: new Uint8ClampedArray(imageData.data),
      width: imageData.width,
      height: imageData.height,
      channels: 4,
    };
  }

  async extractForOCR(region: ImageRegion): Promise<Buffer> {
    if (!this.ctx || !this.canvas) throw new Error('Image not loaded');

    // Create a temporary canvas for the cropped region
    const tempCanvas = createCanvas(region.width, region.height);
    const tempCtx = tempCanvas.getContext('2d');

    // Copy the region to the temp canvas
    tempCtx.drawImage(this.canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);

    // Apply grayscale and normalization (similar to Sharp's preprocessing)
    const imageData = tempCtx.getImageData(0, 0, region.width, region.height);
    const data = imageData.data;

    // Find min/max for normalization
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Convert to grayscale using luminosity method
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      if (gray < min) min = gray;
      if (gray > max) max = gray;
    }

    // Apply grayscale and normalize in one pass
    const range = max - min || 1; // Avoid division by zero
    for (let i = 0; i < data.length; i += 4) {
      // Convert to grayscale
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      // Normalize to 0-255 range
      const normalized = Math.round(((gray - min) / range) * 255);
      data[i] = normalized; // R
      data[i + 1] = normalized; // G
      data[i + 2] = normalized; // B
      // Alpha stays the same
    }

    tempCtx.putImageData(imageData, 0, 0);

    // Return as PNG buffer (Tesseract.js in Node can read PNG buffers)
    return tempCanvas.toBuffer('image/png');
  }

  getSourceName(): string {
    return this.sourceName;
  }
}
