// Compatibility exports: HTTP and BLE share one lighting engine and error identity.
export {
  LedControllerError,
  DEFAULT_LED_BRIGHTNESS,
  MAX_LED_AUTO_OFF_MINUTES,
  resolveLedLightingOptions,
  type LedControllerErrorCode,
  type LedControllerInfo,
  type LedLightingOptions,
  type LedPixel,
  type LedControllerDriver,
  type LedControllerPreviewTransport,
} from '@boardsesh/wled-ble-protocol/lighting';

/** The shared wall setup choices (0 means never). */
export const SPRAY_WALL_LED_AUTO_OFF_CHOICES = [0, 15, 30, 60, 120] as const;
