/** API5 shares native-resolution fields across viewport sizes and surfaces. */
export function auraGpuRenderWidth(catalogueNative: boolean, renderWidth?: number): number | undefined {
  return catalogueNative ? undefined : renderWidth;
}
