/** Browser imports use the notification feed; native push tokens are never stored here. */
export async function registerNotificationDevice(_requestPermission = false, _force = false): Promise<boolean> {
  return false;
}
export async function deactivateNotificationDevice(): Promise<void> {}
