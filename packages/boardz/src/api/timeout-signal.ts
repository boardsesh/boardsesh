/**
 * An AbortSignal that fires after `ms`. Built from AbortController + setTimeout
 * rather than AbortSignal.timeout, which not every Hermes version has.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}
