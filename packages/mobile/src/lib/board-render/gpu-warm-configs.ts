/**
 * The live GPU drawings that have presented a frame in this JS runtime.
 *
 * A first presentation pays for work the native side then keeps for the life of
 * the process: the Metal/GLES pipeline compiled from source, the Rust packet
 * session (keyed by the full static config, four kept) and the CPU chunk cache
 * of rasterized holds (process-wide). Measured on the reference phones that
 * first presentation takes 680–1080 ms; later ones 30–80 ms. Until a drawing is
 * warm here the board may render its PNG at once, as it always did; once warm
 * it goes GPU first (docs/rendering/gpu-climb-overlay-experiment.md).
 *
 * Backgrounding releases only GPU buffers (`releaseGPU`); sessions, chunks and
 * the pipeline survive, so a warm drawing stays warm. Memory only: a reload
 * starts cold, which is right because the native process may be new too.
 */
const MAX_WARM_CONFIGS = 16;
const warmConfigs = new Set<string>();

export function isGpuConfigWarm(gpuWarmKey: string): boolean {
  return warmConfigs.has(gpuWarmKey);
}

export function markGpuConfigWarm(gpuWarmKey: string): void {
  if (warmConfigs.has(gpuWarmKey)) return;
  // Insertion order is the eviction order; an evicted drawing only costs one
  // early PNG the next time it opens cold.
  if (warmConfigs.size >= MAX_WARM_CONFIGS) warmConfigs.delete(warmConfigs.values().next().value!);
  warmConfigs.add(gpuWarmKey);
}

/** Test-only: forget every warm drawing, as a reload does. */
export function _resetGpuWarmConfigsForTests(): void {
  warmConfigs.clear();
}
