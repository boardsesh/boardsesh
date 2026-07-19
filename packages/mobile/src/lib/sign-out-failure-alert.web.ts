export function showSignOutFailure(title: string, message: string): void {
  if (typeof window === 'undefined') return;
  window.alert(`${title}\n\n${message}`);
}
