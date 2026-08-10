/** Timeout choices exposed by the mobile auto-disconnect setting. */
export const AUTO_DISCONNECT_TIMEOUT_OPTIONS = [10, 15, 30, 45, 60, 120, 300, 600] as const;

// Keep the controller independent of the browser-versus-native timer handle
// shape. The mobile test runner and the native runtime return different values.
type TimerHandle = number | object;

export type AutoDisconnectControllerOptions = {
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  onExpire: () => void;
};

/**
 * Small platform-neutral deadline controller. The generation token is checked
 * by every callback, so a timer from a previous connection cannot disconnect a
 * newly-established connection during a reconnect race.
 */
export class AutoDisconnectController {
  private readonly now: () => number;
  private readonly scheduleTimeout: NonNullable<AutoDisconnectControllerOptions['setTimeout']>;
  private readonly cancelTimeout: NonNullable<AutoDisconnectControllerOptions['clearTimeout']>;
  private readonly onExpire: () => void;
  private timer: TimerHandle | null = null;
  private deadlineMs: number | null = null;
  private generation = 0;
  private connected = false;
  private enabled = false;
  private timeoutSeconds = 30;

  constructor(options: AutoDisconnectControllerOptions) {
    this.now = options.now ?? Date.now;
    this.scheduleTimeout =
      options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs) as unknown as TimerHandle);
    this.cancelTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer as unknown as number));
    this.onExpire = options.onExpire;
  }

  update(enabled: boolean, timeoutSeconds: number): void {
    this.enabled = enabled;
    this.timeoutSeconds = timeoutSeconds;
    this.invalidate();
    if (this.connected && enabled) this.arm();
  }

  connectedNow(): void {
    this.connected = true;
    this.invalidate();
    if (this.enabled) this.arm();
  }

  disconnectedNow(): void {
    this.connected = false;
    this.invalidate();
  }

  reset(): void {
    if (!this.connected || !this.enabled) return;
    this.invalidate();
    this.arm();
  }

  /** Re-check the wall-clock deadline after the app returns to the foreground. */
  resume(): void {
    if (!this.connected || !this.enabled || this.deadlineMs === null) return;
    const existingDeadlineMs = this.deadlineMs;
    if (existingDeadlineMs <= this.now()) {
      this.expire(this.generation);
      return;
    }
    this.invalidate();
    this.arm(existingDeadlineMs);
  }

  /** Exposed for a focused UI/provider test without waiting for fake timers. */
  getDeadlineMs(): number | null {
    return this.deadlineMs;
  }

  private invalidate(): void {
    this.generation += 1;
    if (this.timer !== null) {
      this.cancelTimeout(this.timer);
      this.timer = null;
    }
    this.deadlineMs = null;
  }

  private arm(existingDeadlineMs?: number | null): void {
    const token = this.generation;
    const deadlineMs = existingDeadlineMs ?? this.now() + this.timeoutSeconds * 1000;
    this.deadlineMs = deadlineMs;
    this.timer = this.scheduleTimeout(() => this.expire(token), Math.max(0, deadlineMs - this.now()));
  }

  private expire(token: number): void {
    if (token !== this.generation || !this.connected || !this.enabled) return;
    this.invalidate();
    this.onExpire();
  }
}
