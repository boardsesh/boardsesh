/** Defer optional work until a frame has painted and the JS thread has idle time. */
export function scheduleIdleTask(callback: () => void): { cancel: () => void } {
  let cancelled = false;
  let idleHandle: number | undefined;
  let fallbackHandle: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (!cancelled) callback();
  };
  const frameHandle = requestAnimationFrame(() => {
    if (cancelled) return;
    if (typeof requestIdleCallback === 'function') {
      // RN 0.88 installs this native API in Libraries/Core/setUpTimers.js.
      idleHandle = requestIdleCallback(run, { timeout: 2_000 });
    } else {
      // Browser engines without idle callbacks still defer work past the frame.
      fallbackHandle = setTimeout(run, 0);
    }
  });

  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(frameHandle);
      if (idleHandle !== undefined) cancelIdleCallback(idleHandle);
      if (fallbackHandle !== undefined) clearTimeout(fallbackHandle);
    },
  };
}
