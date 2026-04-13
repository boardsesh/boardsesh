import { useCallback } from 'react';
import chalkPuff from '@/app/lib/chalk-puff';

/**
 * Returns a function that fires a chalk puff burst.
 * Pass an HTMLElement to anchor the burst origin to that element,
 * otherwise it bursts from the bottom-center of the viewport.
 */
export function useChalkPuff() {
  const fireChalkPuff = useCallback((originElement?: HTMLElement | null) => {
    let x = 0.5;
    let y = 0.9;

    if (originElement) {
      const rect = originElement.getBoundingClientRect();
      x = (rect.left + rect.width / 2) / window.innerWidth;
      y = (rect.top + rect.height / 2) / window.innerHeight;
    }

    chalkPuff({
      particleCount: 45,
      spread: 120,
      startVelocity: 22,
      decay: 0.93,
      scalar: 0.9,
      ticks: 80,
      origin: { x, y },
      gravity: -0.2,
      disableForReducedMotion: true,
    });
  }, []);

  return fireChalkPuff;
}
