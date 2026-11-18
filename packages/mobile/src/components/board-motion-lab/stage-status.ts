/** How the lab's stage is drawing the board, from what it can see. Pure. */
import type { LabLookStatus, LabRenderStatus } from './types';

/** The native view that draws the stationary board's motion at all (`NativeMotionClimbOverlayGPU`). */
export const MOTION_NATIVE_API = 3;

export type StageStatusInput = {
  /** The board has bundled art and hold positions. */
  hasRenderData: boolean;
  hasClimbs: boolean;
  /** `climbOverlayGpuApiVersion`: 0 without the module, 1 on the iOS Simulator. */
  apiVersion: number;
  hasMotionView: boolean;
  /** Settings › Board › GPU acceleration. */
  gpuSettingOn: boolean;
  /** `useGpuClimbOverlayEnabled` under the lab's forced flag: false only when switched off. */
  gpuAllowed: boolean;
  /** `usePlayerGpuBoard`: this board and render style have a GPU drawing. */
  gpuBoard: boolean;
  /** What the carousel says it is drawing; null until it says. */
  renderPath: 'gpu' | 'png' | null;
  /** The last presented trio's native timings; null until one is presented. */
  timings: { prepareMs: number; uploadMs: number } | null;
  /** The native reason the last trio failed, if it did since the last presentation. */
  gpuError: string | null;
  /**
   * Look variants: the native swap look's state. A to C: undefined, except on
   * Android when the probe turned the look off, which every variant reports.
   */
  look?: LabLookStatus;
};

export function stageStatus(input: StageStatusInput): LabRenderStatus {
  const { apiVersion } = input;
  const png = (reason: string): LabRenderStatus => ({ path: 'png', apiVersion, reason });
  if (!input.hasRenderData) return png('no bundled art for this board');
  if (!input.hasClimbs) return png('no climbs in this set');
  if (apiVersion === 0) return png('this build has no GPU board');
  if (!input.hasMotionView) {
    return png(
      `native API ${apiVersion} has no moving GPU board (needs ${MOTION_NATIVE_API}; the iOS Simulator reports 1)`,
    );
  }
  if (!input.gpuSettingOn) return png('GPU acceleration is off in Settings › Board');
  if (!input.gpuAllowed) return png('GPU switched off remotely (aura-gpu-enabled)');
  if (!input.gpuBoard) return png('no GPU drawing for this board or render style');
  if (input.renderPath === 'png') {
    return png(
      input.gpuError ? `GPU failed: ${input.gpuError}` : 'GPU refused these climbs (an earlier failure is latched)',
    );
  }
  if (input.renderPath === 'gpu' && input.timings !== null) {
    return {
      path: 'gpu',
      apiVersion,
      prepareMs: input.timings.prepareMs,
      uploadMs: input.timings.uploadMs,
      ...(input.look ? { look: input.look } : null),
    };
  }
  return { path: 'loading' };
}
