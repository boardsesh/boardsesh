'use client';

// Kiosk display health carries only non-personal operational properties.

import { useEffect } from 'react';
import { captureKioskPageLoad } from '@/app/lib/kiosk-telemetry';

export default function KioskAnalytics() {
  useEffect(() => {
    captureKioskPageLoad();
  }, []);
  return null;
}
