export type LedControllerErrorCode =
  | 'invalid-url'
  | 'not-local'
  | 'unavailable'
  | 'not-wled'
  | 'timeout'
  | 'command-failed'
  | 'invalid-indices'
  | 'cancelled';

export class LedControllerError extends Error {
  constructor(public readonly code: LedControllerErrorCode) {
    super(code);
    this.name = 'LedControllerError';
  }
}

export interface LedControllerInfo {
  name: string;
  version: string;
  /** LEDs on the cable; 0 when the protocol does not report it (Bluetooth). */
  ledCount: number;
}

/** Per-wall lighting preferences a driver applies whenever it wakes the controller. */
export interface LedLightingOptions {
  /** Master brightness, 1–255. Defaults to 64 when absent. */
  brightness?: number;
  /** Turn the wall off this many minutes after it was last lit (1–255); 0 or absent never does. */
  autoOffMinutes?: number;
}

export const DEFAULT_LED_BRIGHTNESS = 64;
export const MAX_LED_AUTO_OFF_MINUTES = 255;

/** Clamp untrusted options to the controller's ranges. */
export function resolveLedLightingOptions(options: LedLightingOptions = {}): {
  brightness: number;
  autoOffMinutes: number;
} {
  const brightness = Number.isFinite(options.brightness)
    ? Math.min(255, Math.max(1, Math.round(options.brightness ?? DEFAULT_LED_BRIGHTNESS)))
    : DEFAULT_LED_BRIGHTNESS;
  const autoOffMinutes = Number.isFinite(options.autoOffMinutes)
    ? Math.min(MAX_LED_AUTO_OFF_MINUTES, Math.max(0, Math.round(options.autoOffMinutes ?? 0)))
    : 0;
  return { brightness, autoOffMinutes };
}

/** An RGB route colour for one physical LED on the configured cable. */
export type LedPixel = { index: number; color: readonly [number, number, number] };

/** Drivers own transport and hardware details; the wall editor owns settings. */
export interface LedControllerDriver {
  /**
   * Validate and canonicalize a controller address before anything contacts it.
   * Absent: the address is a local-network HTTP URL (`normalizeLocalControllerUrl`).
   */
  normalizeTarget?(target: string): string;
  probe(url: string, signal?: AbortSignal): Promise<LedControllerInfo>;
  lightAll(url: string, signal?: AbortSignal, options?: LedLightingOptions): Promise<void>;
  turnOff(url: string, signal?: AbortSignal): Promise<void>;
  createPreview(url: string, options?: LedLightingOptions): LedControllerPreviewTransport;
}

/** A single serialized preview owns its cached count and previously lit LEDs. */
export interface LedControllerPreviewTransport {
  show(indices: readonly number[], colors?: readonly LedPixel[]): Promise<void>;
  lightAll(): Promise<void>;
  turnOff(): Promise<void>;
}
