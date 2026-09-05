import type {
  HoldComponentLocation,
  HoldMorphologyExtraction,
  HoldMorphologyOptions,
  HoldMorphologyVector,
  HoldPixelLocation,
  PreparedMorphologyComponent,
  PreparedMorphologyImage,
  RawRgbaImage,
} from './types.js';

const DEFAULT_OPTIONS: Required<HoldMorphologyOptions> = {
  alphaThreshold: 24,
  minimumComponentPixels: 12,
  searchRadiusFraction: 0.45,
  textureEdgeThreshold: 0.12,
};

type Point = { x: number; y: number };

function assertImageShape(image: RawRgbaImage): void {
  if (!Number.isInteger(image.width) || image.width <= 0 || !Number.isInteger(image.height) || image.height <= 0) {
    throw new Error(`Morphology image dimensions must be positive integers, got ${image.width}x${image.height}`);
  }
  if (image.channels !== 4) {
    throw new Error(`Morphology extraction requires RGBA input, got ${image.channels} channels`);
  }
  const expectedLength = image.width * image.height * image.channels;
  if (image.data.length !== expectedLength) {
    throw new Error(`Morphology image has ${image.data.length} bytes; expected ${expectedLength}`);
  }
}

function resolveOptions(options: HoldMorphologyOptions): Required<HoldMorphologyOptions> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  if (resolved.alphaThreshold < 1 || resolved.alphaThreshold > 255) {
    throw new Error(`alphaThreshold must be between 1 and 255, got ${resolved.alphaThreshold}`);
  }
  if (!Number.isInteger(resolved.minimumComponentPixels) || resolved.minimumComponentPixels < 1) {
    throw new Error(`minimumComponentPixels must be a positive integer, got ${resolved.minimumComponentPixels}`);
  }
  if (resolved.searchRadiusFraction <= 0 || resolved.searchRadiusFraction > 1) {
    throw new Error(`searchRadiusFraction must be in (0, 1], got ${resolved.searchRadiusFraction}`);
  }
  if (resolved.textureEdgeThreshold < 0 || resolved.textureEdgeThreshold > 1) {
    throw new Error(`textureEdgeThreshold must be in [0, 1], got ${resolved.textureEdgeThreshold}`);
  }
  return resolved;
}

function alphaAt(image: RawRgbaImage, pixelIndex: number): number {
  return image.data[pixelIndex * image.channels + 3] ?? 0;
}

/**
 * Label the alpha silhouette once per committed PNG. Each placement can then
 * select its nearest component without re-running flood fill over the image.
 */
export function prepareMorphologyImage(
  image: RawRgbaImage,
  options: HoldMorphologyOptions = {},
): PreparedMorphologyImage {
  assertImageShape(image);
  const resolvedOptions = resolveOptions(options);
  const pixelCount = image.width * image.height;
  const labels = new Int32Array(pixelCount);
  labels.fill(-1);

  const components: PreparedMorphologyComponent[] = [];
  let foregroundPixelCount = 0;

  for (let seedIndex = 0; seedIndex < pixelCount; seedIndex++) {
    if (labels[seedIndex] !== -1 || alphaAt(image, seedIndex) < resolvedOptions.alphaThreshold) continue;

    const componentId = components.length;
    const queuedPixels = [seedIndex];
    const componentPixels: number[] = [];
    labels[seedIndex] = componentId;
    let queueOffset = 0;
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;

    while (queueOffset < queuedPixels.length) {
      const pixelIndex = queuedPixels[queueOffset++];
      componentPixels.push(pixelIndex);
      foregroundPixelCount++;

      const x = pixelIndex % image.width;
      const y = Math.floor(pixelIndex / image.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (let deltaY = -1; deltaY <= 1; deltaY++) {
        for (let deltaX = -1; deltaX <= 1; deltaX++) {
          if (deltaX === 0 && deltaY === 0) continue;
          const neighborX = x + deltaX;
          const neighborY = y + deltaY;
          if (neighborX < 0 || neighborY < 0 || neighborX >= image.width || neighborY >= image.height) continue;
          const neighborIndex = neighborY * image.width + neighborX;
          if (labels[neighborIndex] === -1 && alphaAt(image, neighborIndex) >= resolvedOptions.alphaThreshold) {
            labels[neighborIndex] = componentId;
            queuedPixels.push(neighborIndex);
          }
        }
      }
    }

    components.push({
      id: componentId,
      pixelIndices: componentPixels,
      minX,
      minY,
      maxX,
      maxY,
    });
  }

  return { image, labels, components, foregroundPixelCount, options: resolvedOptions };
}

function findNearestComponent(
  prepared: PreparedMorphologyImage,
  location: HoldPixelLocation,
): { component: PreparedMorphologyComponent; normalizedCenterDistance: number } | null {
  const { image, labels, components, options } = prepared;
  const centerX = Math.round(location.centerX);
  const centerY = Math.round(location.centerY);
  const searchRadius = Math.max(
    1,
    Math.ceil(Math.min(location.cellWidth, location.cellHeight) * options.searchRadiusFraction),
  );
  let bestComponentId = -1;
  let bestDistanceSquared = Infinity;
  let bestPixelIndex = Infinity;

  const minX = Math.max(0, centerX - searchRadius);
  const maxX = Math.min(image.width - 1, centerX + searchRadius);
  const minY = Math.max(0, centerY - searchRadius);
  const maxY = Math.min(image.height - 1, centerY + searchRadius);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const pixelIndex = y * image.width + x;
      const componentId = labels[pixelIndex] ?? -1;
      if (componentId < 0) continue;
      const component = components[componentId];
      if (!component || component.pixelIndices.length < options.minimumComponentPixels) continue;

      const distanceSquared = (x - location.centerX) ** 2 + (y - location.centerY) ** 2;
      if (distanceSquared > searchRadius ** 2) continue;
      if (
        distanceSquared < bestDistanceSquared ||
        (distanceSquared === bestDistanceSquared && pixelIndex < bestPixelIndex)
      ) {
        bestComponentId = componentId;
        bestDistanceSquared = distanceSquared;
        bestPixelIndex = pixelIndex;
      }
    }
  }

  const component = bestComponentId >= 0 ? components[bestComponentId] : undefined;
  if (!component) return null;
  return {
    component,
    normalizedCenterDistance: roundFeature(
      Math.sqrt(bestDistanceSquared) / Math.min(location.cellWidth, location.cellHeight),
    ),
  };
}

function isComponentPixel(image: RawRgbaImage, componentPixels: ReadonlySet<number>, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
  return componentPixels.has(y * image.width + x);
}

function luminanceAt(image: RawRgbaImage, pixelIndex: number): number {
  const byteOffset = pixelIndex * image.channels;
  const red = image.data[byteOffset] ?? 0;
  const green = image.data[byteOffset + 1] ?? 0;
  const blue = image.data[byteOffset + 2] ?? 0;
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function cross(origin: Point, first: Point, second: Point): number {
  return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
}

function convexHull(points: readonly Point[]): Point[] {
  if (points.length <= 1) return [...points];
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  const unique = sorted.filter(
    (point, index) => index === 0 || point.x !== sorted[index - 1]?.x || point.y !== sorted[index - 1]?.y,
  );
  if (unique.length <= 2) return unique;

  const lower: Point[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point[] = [];
  for (let index = unique.length - 1; index >= 0; index--) {
    const point = unique[index]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function roundFeature(feature: number): number {
  if (!Number.isFinite(feature)) return 0;
  return Math.round(feature * 1e8) / 1e8;
}

function clipComponentToCell(
  component: PreparedMorphologyComponent,
  image: RawRgbaImage,
  location: HoldPixelLocation,
  minimumComponentPixels: number,
):
  | { ok: true; component: PreparedMorphologyComponent; clipped: boolean }
  | { ok: false; reason: 'insufficient-cell-pixels' } {
  if (!location.clipToCell) return { ok: true, component, clipped: false };

  const minX = location.centerX - location.cellWidth / 2;
  const maxX = location.centerX + location.cellWidth / 2;
  const minY = location.centerY - location.cellHeight / 2;
  const maxY = location.centerY + location.cellHeight / 2;
  const pixelIndices = component.pixelIndices.filter((pixelIndex) => {
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    return x + 0.5 >= minX && x + 0.5 < maxX && y + 0.5 >= minY && y + 0.5 < maxY;
  });
  if (pixelIndices.length < minimumComponentPixels) {
    return { ok: false, reason: 'insufficient-cell-pixels' };
  }

  let clippedMinX = image.width;
  let clippedMinY = image.height;
  let clippedMaxX = -1;
  let clippedMaxY = -1;
  for (const pixelIndex of pixelIndices) {
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    clippedMinX = Math.min(clippedMinX, x);
    clippedMinY = Math.min(clippedMinY, y);
    clippedMaxX = Math.max(clippedMaxX, x);
    clippedMaxY = Math.max(clippedMaxY, y);
  }

  return {
    ok: true,
    component: {
      id: component.id,
      pixelIndices,
      minX: clippedMinX,
      minY: clippedMinY,
      maxX: clippedMaxX,
      maxY: clippedMaxY,
    },
    clipped: true,
  };
}

function componentVector(
  prepared: PreparedMorphologyImage,
  component: PreparedMorphologyComponent,
  location: HoldPixelLocation,
): HoldMorphologyVector {
  const { image, options } = prepared;
  const componentPixels = new Set(component.pixelIndices);
  const componentArea = component.pixelIndices.length;
  const boundingWidth = component.maxX - component.minX + 1;
  const boundingHeight = component.maxY - component.minY + 1;
  const normalizedWidth = boundingWidth / location.cellWidth;
  const normalizedHeight = boundingHeight / location.cellHeight;

  let horizontalBoundaryEdges = 0;
  let verticalBoundaryEdges = 0;
  let weightedLuminanceSum = 0;
  let weightedLuminanceSquaredSum = 0;
  let alphaWeightSum = 0;
  let normalizedXSum = 0;
  let normalizedYSum = 0;
  const hullCorners: Point[] = [];

  for (const pixelIndex of component.pixelIndices) {
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    const leftExposed = !isComponentPixel(image, componentPixels, x - 1, y);
    const rightExposed = !isComponentPixel(image, componentPixels, x + 1, y);
    const topExposed = !isComponentPixel(image, componentPixels, x, y - 1);
    const bottomExposed = !isComponentPixel(image, componentPixels, x, y + 1);
    verticalBoundaryEdges += Number(leftExposed) + Number(rightExposed);
    horizontalBoundaryEdges += Number(topExposed) + Number(bottomExposed);

    if (leftExposed || rightExposed || topExposed || bottomExposed) {
      hullCorners.push({ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 });
    }

    const alphaWeight = alphaAt(image, pixelIndex) / 255;
    const luminance = luminanceAt(image, pixelIndex);
    weightedLuminanceSum += luminance * alphaWeight;
    weightedLuminanceSquaredSum += luminance * luminance * alphaWeight;
    alphaWeightSum += alphaWeight;
    normalizedXSum += (x + 0.5) / location.cellWidth;
    normalizedYSum += (y + 0.5) / location.cellHeight;
  }

  const centroidX = normalizedXSum / componentArea;
  const centroidY = normalizedYSum / componentArea;
  let covarianceXX = 0;
  let covarianceYY = 0;
  let covarianceXY = 0;
  let textureEdgePixels = 0;

  for (const pixelIndex of component.pixelIndices) {
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    const normalizedX = (x + 0.5) / location.cellWidth;
    const normalizedY = (y + 0.5) / location.cellHeight;
    const deltaX = normalizedX - centroidX;
    const deltaY = normalizedY - centroidY;
    covarianceXX += deltaX * deltaX;
    covarianceYY += deltaY * deltaY;
    covarianceXY += deltaX * deltaY;

    const centerLuminance = luminanceAt(image, pixelIndex);
    const sampleLuminance = (sampleX: number, sampleY: number): number => {
      if (!isComponentPixel(image, componentPixels, sampleX, sampleY)) return centerLuminance;
      return luminanceAt(image, sampleY * image.width + sampleX);
    };
    const topLeft = sampleLuminance(x - 1, y - 1);
    const top = sampleLuminance(x, y - 1);
    const topRight = sampleLuminance(x + 1, y - 1);
    const left = sampleLuminance(x - 1, y);
    const right = sampleLuminance(x + 1, y);
    const bottomLeft = sampleLuminance(x - 1, y + 1);
    const bottom = sampleLuminance(x, y + 1);
    const bottomRight = sampleLuminance(x + 1, y + 1);
    const gradientX = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
    const gradientY = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
    const normalizedGradient = Math.hypot(gradientX, gradientY) / (4 * Math.SQRT2);
    if (normalizedGradient >= options.textureEdgeThreshold) textureEdgePixels++;
  }

  covarianceXX /= componentArea;
  covarianceYY /= componentArea;
  covarianceXY /= componentArea;
  const covarianceTrace = covarianceXX + covarianceYY;
  const covarianceDifference = covarianceXX - covarianceYY;
  const eigenvalueDelta = Math.hypot(covarianceDifference, 2 * covarianceXY);
  const majorEigenvalue = Math.max(0, (covarianceTrace + eigenvalueDelta) / 2);
  const minorEigenvalue = Math.max(0, (covarianceTrace - eigenvalueDelta) / 2);
  const eccentricity = majorEigenvalue > 0 ? Math.sqrt(Math.max(0, 1 - minorEigenvalue / majorEigenvalue)) : 0;
  const doubledOrientation = Math.atan2(2 * covarianceXY, covarianceDifference);

  const hullArea = polygonArea(convexHull(hullCorners));
  const meanLuminance = alphaWeightSum > 0 ? weightedLuminanceSum / alphaWeightSum : 0;
  const luminanceVariance =
    alphaWeightSum > 0 ? Math.max(0, weightedLuminanceSquaredSum / alphaWeightSum - meanLuminance * meanLuminance) : 0;
  const normalizedPerimeter =
    (horizontalBoundaryEdges / location.cellWidth + verticalBoundaryEdges / location.cellHeight) / 4;

  return [
    roundFeature(componentArea / (location.cellWidth * location.cellHeight)),
    roundFeature(normalizedWidth),
    roundFeature(normalizedHeight),
    roundFeature(Math.log(Math.max(normalizedWidth, Number.EPSILON) / Math.max(normalizedHeight, Number.EPSILON))),
    roundFeature(normalizedPerimeter),
    roundFeature(hullArea > 0 ? Math.min(1, componentArea / hullArea) : 1),
    roundFeature(eccentricity),
    roundFeature(Math.sin(doubledOrientation)),
    roundFeature(Math.cos(doubledOrientation)),
    roundFeature(textureEdgePixels / componentArea),
    roundFeature(meanLuminance),
    roundFeature(Math.sqrt(luminanceVariance)),
  ];
}

export function extractHoldMorphology(
  prepared: PreparedMorphologyImage,
  location: HoldPixelLocation,
): HoldMorphologyExtraction {
  const located = locateHoldComponent(prepared, location);
  if (!located.ok) return located;
  const nearestComponent = prepared.components[located.componentId];
  if (!nearestComponent) return { ok: false, reason: 'missing-hold' };
  const clippedComponent = clipComponentToCell(
    nearestComponent,
    prepared.image,
    location,
    prepared.options.minimumComponentPixels,
  );
  if (!clippedComponent.ok) return clippedComponent;
  const { component, clipped } = clippedComponent;
  return {
    ok: true,
    componentId: component.id,
    componentPixelCount: component.pixelIndices.length,
    normalizedCenterDistance: located.normalizedCenterDistance,
    componentWasClipped: clipped,
    vector: componentVector(prepared, component, location),
  };
}

/** Resolve a hold centre to an alpha component without calculating its feature vector. */
export function locateHoldComponent(
  prepared: PreparedMorphologyImage,
  location: HoldPixelLocation,
): HoldComponentLocation {
  if (location.cellWidth <= 0 || location.cellHeight <= 0) {
    throw new Error(`Morphology cell dimensions must be positive, got ${location.cellWidth}x${location.cellHeight}`);
  }
  if (prepared.foregroundPixelCount === 0) return { ok: false, reason: 'empty-image' };
  const nearest = findNearestComponent(prepared, location);
  if (!nearest) return { ok: false, reason: 'missing-hold' };
  return {
    ok: true,
    componentId: nearest.component.id,
    componentPixelCount: nearest.component.pixelIndices.length,
    normalizedCenterDistance: nearest.normalizedCenterDistance,
  };
}
