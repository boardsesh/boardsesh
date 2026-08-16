import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from './directory-page';

/**
 * `/gyms` — the flat directory.
 *
 * One of four LITERAL route folders (`/gyms`, `/gyms/kilter`,
 * `/gyms/moonboard`, `/gyms/tension`) rather than a `[facet]` dynamic segment.
 * That is a deliberate IA decision, not boilerplate: with literal folders
 * "no standalone routes for the long-tail board types" is structurally true —
 * `/gyms/soill` 404s because nothing routes it, with no runtime allow-list to
 * drift — and #4381's sitemap gets four static paths instead of a regex it has
 * to keep in sync.
 */
export async function generateMetadata(): Promise<Metadata> {
  return generateGymDirectoryMetadata('all');
}

export default async function GymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('all', props);
}
