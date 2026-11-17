/** One decision for native Aura surfaces, configuration building and motion. */
export function supportsAuraGpu(input: {
  boardName: string;
  layoutId: number;
  catalogueNative: boolean;
  renderMode?: string;
  softDisc?: boolean;
  markStyle?: string;
  width?: number;
  height?: number;
  holdCount?: number;
  roleCodes?: readonly number[];
  frames?: string;
}): boolean {
  const { boardName, layoutId, catalogueNative, roleCodes, frames } = input;
  if (input.renderMode === 'classic' || input.softDisc) return false;
  // Filled marks retain the exact PNG path: dense clipped fill passes still
  // differ from tiny-skia by two channel bytes in the native parity census.
  if (input.markStyle === 'fill' || input.markStyle === 'glow-fill') return false;
  if (!['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill', 'moonboard', 'woods'].includes(boardName)) {
    return false;
  }
  // API2/3 still prepares the four Homewall roles understood by those binaries.
  if (!catalogueNative && (boardName !== 'kilter' || layoutId !== 8)) return false;
  if (input.width !== undefined && (!Number.isFinite(input.width) || input.width <= 0 || input.width > 1536))
    return false;
  if (
    input.height !== undefined &&
    (!Number.isFinite(input.height) || input.height <= 0 || input.height > (catalogueNative ? 2304 : 2048))
  )
    return false;
  if (input.holdCount !== undefined && (input.holdCount <= 0 || input.holdCount > 1024)) return false;
  if (
    roleCodes &&
    (roleCodes.length > (catalogueNative ? 32 : 4) || roleCodes.some((code) => !Number.isSafeInteger(code)))
  )
    return false;
  if (frames !== undefined) {
    const supported = new Set(roleCodes ?? (catalogueNative ? [] : [42, 43, 44, 45]));
    if ([...frames.matchAll(/r(\d+)/g)].some((match) => !supported.has(Number(match[1])))) return false;
  }
  return true;
}
