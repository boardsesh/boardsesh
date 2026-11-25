import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from '@/app/gyms/directory-page';

/** `/gyms/moonboard` — the same shell, filtered to gyms with a MoonBoard. */
export async function generateMetadata(props: DirectoryRouteProps): Promise<Metadata> {
  return generateGymDirectoryMetadata('moonboard', await props.searchParams);
}

export default async function MoonboardGymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('moonboard', props);
}
