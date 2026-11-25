// /kiosk/{gym-slug}/{kiosk-slug} — a specific named kiosk for gyms running
// more than one TV. Same public renderer as the default-kiosk route.

import React from 'react';
import type { Metadata } from 'next';
import KioskPageRenderer, { buildKioskMetadata } from '@/app/components/kiosk/kiosk-page-renderer';

type NamedKioskRouteProps = {
  params: Promise<{ gym_slug: string; kiosk_slug: string }>;
};

export async function generateMetadata(props: NamedKioskRouteProps): Promise<Metadata> {
  const { gym_slug, kiosk_slug } = await props.params;
  return buildKioskMetadata(gym_slug, kiosk_slug);
}

export default async function NamedGymKioskPage(props: NamedKioskRouteProps) {
  const { gym_slug, kiosk_slug } = await props.params;
  return <KioskPageRenderer gymSlug={gym_slug} kioskSlug={kiosk_slug} />;
}
