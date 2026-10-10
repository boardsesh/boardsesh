import sharp from 'sharp';

/** Extract the captured black Island silhouette, preserving every pixel inside it. */
export async function extractScreenshotIsland(source: Buffer): Promise<Buffer> {
  const { data: pixels, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const searchHeight = Math.min(650, height);
  const dark = (index: number) =>
    pixels[index * channels] <= 16 && pixels[index * channels + 1] <= 16 && pixels[index * channels + 2] <= 16;
  const center = Math.floor(width / 2);
  let seed = -1;
  for (let row = 1; row < Math.min(120, searchHeight - 10); row++) {
    if (Array.from({ length: 10 }, (_, offset) => (row + offset) * width + center).every(dark)) {
      seed = (row + 5) * width + center;
      break;
    }
  }
  if (seed < 0) throw new Error('Expanded Dynamic Island silhouette is missing');

  // Only the connected black surface defines the outline. Filling between its
  // left/right edges restores the captured text, thumbnail and colored controls.
  const visited = new Uint8Array(width * searchHeight);
  const queue = new Int32Array(visited.length);
  const leftEdges = new Int32Array(searchHeight).fill(width);
  const rightEdges = new Int32Array(searchHeight).fill(-1);
  let queued = 1;
  queue[0] = seed;
  visited[seed] = 1;
  for (let cursor = 0; cursor < queued; cursor++) {
    const index = queue[cursor];
    const row = Math.floor(index / width);
    const column = index % width;
    leftEdges[row] = Math.min(leftEdges[row], column);
    rightEdges[row] = Math.max(rightEdges[row], column);
    for (const neighbor of [
      column > 0 ? index - 1 : -1,
      column < width - 1 ? index + 1 : -1,
      index - width,
      index + width,
    ]) {
      if (neighbor < 0 || neighbor >= visited.length || visited[neighbor] || !dark(neighbor)) continue;
      visited[neighbor] = 1;
      queue[queued++] = neighbor;
    }
  }
  const top = leftEdges.findIndex((edge) => edge < width);
  let bottom = searchHeight - 1;
  while (rightEdges[bottom] < 0) bottom--;
  const left = Math.min(...leftEdges);
  const right = Math.max(...rightEdges);
  const islandWidth = right - left + 1;
  const islandHeight = bottom - top + 1;
  if (
    top < 1 ||
    bottom >= searchHeight - 1 ||
    islandWidth < width * 0.85 ||
    islandWidth > width * 0.98 ||
    islandHeight < 350 ||
    islandHeight > 550 ||
    Math.abs(left - (width - right - 1)) > 12
  )
    throw new Error('Expanded Dynamic Island outline does not match the supported native captures');

  const cutout = Buffer.alloc(islandWidth * islandHeight * 4);
  for (let row = top; row <= bottom; row++) {
    if (leftEdges[row] >= rightEdges[row]) throw new Error('Expanded Dynamic Island outline is incomplete');
    for (let column = leftEdges[row]; column <= rightEdges[row]; column++) {
      const sourceOffset = (row * width + column) * channels;
      const outputOffset = ((row - top) * islandWidth + column - left) * 4;
      cutout[outputOffset] = pixels[sourceOffset];
      cutout[outputOffset + 1] = pixels[sourceOffset + 1];
      cutout[outputOffset + 2] = pixels[sourceOffset + 2];
      cutout[outputOffset + 3] = 255;
    }
  }
  return sharp(cutout, { raw: { width: islandWidth, height: islandHeight, channels: 4 } })
    .png()
    .toBuffer();
}
