import { useCallback } from 'react';
import confetti from 'canvas-confetti';

/**
 * Returns a function that fires a subtle confetti burst.
 * Pass an HTMLElement to anchor the burst origin to that element,
 * otherwise it bursts from the bottom-center of the viewport.
 */
export function useConfetti() {
  const fireConfetti = useCallback((originElement?: HTMLElement | null) => {
    let x = 0.5;
    let y = 0.9;

    if (originElement && typeof window !== 'undefined') {
      const rect = originElement.getBoundingClientRect();
      x = (rect.left + rect.width / 2) / window.innerWidth;
      y = (rect.top + rect.height / 2) / window.innerHeight;
    }

    confetti({
      particleCount: 35,
      spread: 60,
      startVelocity: 25,
      decay: 0.92,
      scalar: 0.8,
      ticks: 60,
      origin: { x, y },
      gravity: 0.8,
      disableForReducedMotion: true,
    });
  }, []);

  return fireConfetti;
}
