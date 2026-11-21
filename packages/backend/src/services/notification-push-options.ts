/** Durable Expo delivery, shared by spray completion and private support. */
export const NOTIFICATION_PUSH_QUEUE = 'notification-push-delivery';
export const NOTIFICATION_PUSH_RETRIES = {
  retryLimit: 20,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 300,
} as const;
