/** A logical center outside the photograph cannot carve a neighboring physical
 * hold into its own silhouette. Only omit it when that same connected body has
 * another center on substance. Slightly misregistered standalone holds survive.
 */
export function placementsWithoutOwnPhotoBody(
  mask: Uint8Array,
  width: number,
  height: number,
  placements: ReadonlyArray<{ id: number; cx: number; cy: number; r: number }>,
): Set<number> {
  const componentAt = new Int32Array(mask.length).fill(-1);
  let component = 0;
  for (let origin = 0; origin < mask.length; origin += 1) {
    if (mask[origin] !== 1 || componentAt[origin] >= 0) continue;
    const stack = [origin];
    componentAt[origin] = component;
    const visit = (pixel: number) => {
      if (mask[pixel] !== 1 || componentAt[pixel] >= 0) return;
      componentAt[pixel] = component;
      stack.push(pixel);
    };
    while (stack.length > 0) {
      const pixel = stack.pop()!;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x > 0) visit(pixel - 1);
      if (x + 1 < width) visit(pixel + 1);
      if (y > 0) visit(pixel - width);
      if (y + 1 < height) visit(pixel + width);
    }
    component += 1;
  }

  const containedCenters = new Set<number>();
  for (const placement of placements) {
    const x = Math.round(placement.cx);
    const y = Math.round(placement.cy);
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const ownComponent = componentAt[y * width + x];
    if (ownComponent >= 0) containedCenters.add(ownComponent);
  }

  const withoutOwnBody = new Set<number>();
  for (const placement of placements) {
    const cx = Math.round(placement.cx);
    const cy = Math.round(placement.cy);
    if (cx >= 0 && cx < width && cy >= 0 && cy < height && mask[cy * width + cx] === 1) continue;
    const reach = Math.max(4, placement.r * 0.75);
    const bound = Math.ceil(reach);
    let nearestComponent = -1;
    let nearestDistance = Infinity;
    for (let dy = -bound; dy <= bound; dy += 1) {
      for (let dx = -bound; dx <= bound; dx += 1) {
        const distance = dx * dx + dy * dy;
        const x = cx + dx;
        const y = cy + dy;
        if (distance > reach * reach || distance >= nearestDistance || x < 0 || x >= width || y < 0 || y >= height)
          continue;
        const candidateComponent = componentAt[y * width + x];
        if (candidateComponent < 0) continue;
        nearestDistance = distance;
        nearestComponent = candidateComponent;
      }
    }
    if (containedCenters.has(nearestComponent)) withoutOwnBody.add(placement.id);
  }
  return withoutOwnBody;
}

/** Cut measured photographic contact seams on the private segmentation mask.
 * Source RGB and the shipped artwork remain untouched. Points are image pixels.
 */
export function cutPhotoContactSeams(
  mask: Uint8Array,
  width: number,
  height: number,
  seams: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): void {
  for (const seam of seams) {
    for (let index = 1; index < seam.length; index += 1) {
      let x = Math.round(seam[index - 1][0]);
      let y = Math.round(seam[index - 1][1]);
      const endX = Math.round(seam[index][0]);
      const endY = Math.round(seam[index][1]);
      const dx = Math.abs(endX - x);
      const dy = -Math.abs(endY - y);
      const stepX = x < endX ? 1 : -1;
      const stepY = y < endY ? 1 : -1;
      let error = dx + dy;
      while (true) {
        if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 0;
        if (x === endX && y === endY) break;
        const doubled = error * 2;
        if (doubled >= dy) {
          error += dy;
          x += stepX;
        }
        if (doubled <= dx) {
          error += dx;
          y += stepY;
        }
      }
    }
  }
}
