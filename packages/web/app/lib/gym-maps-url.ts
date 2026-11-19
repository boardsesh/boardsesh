/** Public coordinates/address only; a normal link makes no map request before a tap. */
export function gymMapsUrl(gym: {
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
}): string | null {
  const { latitude, longitude } = gym;
  const coordinates =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  const query = coordinates ? `${latitude},${longitude}` : gym.address?.trim();
  return query ? `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query })}` : null;
}
