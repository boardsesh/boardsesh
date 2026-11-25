/** Expo messages can echo tokens and notification contents. Never log raw text. */
const expoErrorMessages = {
  DeviceNotRegistered: 'The device is no longer registered for push notifications.',
  MessageTooBig: 'The notification payload exceeds the provider size limit.',
  MessageRateExceeded: 'The device push rate limit was exceeded.',
  MismatchSenderId: 'The FCM sender does not match the configured credentials.',
  InvalidCredentials: 'The APNs or FCM push credentials are invalid.',
  UNAUTHORIZED: 'Expo push access-token authentication failed.',
} as const;

export function safeExpoPushError(errorCode: string | undefined): { errorCode: string; errorMessage: string } {
  if (errorCode && Object.hasOwn(expoErrorMessages, errorCode)) {
    const knownCode = errorCode as keyof typeof expoErrorMessages;
    return { errorCode: knownCode, errorMessage: expoErrorMessages[knownCode] };
  }
  return { errorCode: 'unknown', errorMessage: 'Expo rejected the notification; upstream message withheld.' };
}

export type PushDeliveryDiagnostic = {
  stage: 'ticket' | 'receipt' | 'validation';
  status: 'pending' | 'receipt' | 'done' | 'skipped';
  reason?: 'device_unavailable' | 'target_unavailable' | 'DeviceNotRegistered' | 'MessageTooBig';
  errorCode?: string;
  errorMessage?: string;
};
