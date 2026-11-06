export type LedControllerErrorCode =
  | 'invalid-url'
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
  ledCount: number;
}

/** Drivers own transport and hardware details; the wall editor owns settings. */
export interface LedControllerDriver {
  probe(url: string, signal?: AbortSignal): Promise<LedControllerInfo>;
  lightAll(url: string, signal?: AbortSignal): Promise<void>;
  turnOff(url: string, signal?: AbortSignal): Promise<void>;
  createPreview(url: string): LedControllerPreviewTransport;
}

/** A single serialized preview owns its cached count and previously lit LEDs. */
export interface LedControllerPreviewTransport {
  show(indices: readonly number[]): Promise<void>;
  lightAll(): Promise<void>;
  turnOff(): Promise<void>;
}
