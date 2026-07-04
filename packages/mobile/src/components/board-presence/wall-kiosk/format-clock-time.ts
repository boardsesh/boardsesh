/**
 * Format a wall-history entry's ISO timestamp as a short clock time for the reel
 * readout ("7:42 PM" / "19:42" per the device locale). Falls back to a manual
 * 12-hour render if `Intl` is unavailable, and to an empty string for junk input.
 */
export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    hours %= 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${meridiem}`;
  }
}
