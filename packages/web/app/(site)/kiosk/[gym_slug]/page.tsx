// /kiosk/{gym-slug} — the gym's default kiosk (its first/only TV config).
// Public, no login: a smart TV opens this URL and stays on it 24/7.

import React from 'react';
import type { Metadata } from 'next';
import KioskPageRenderer, { buildKioskMetadata } from '@/app/components/kiosk/kiosk-page-renderer';

type GymKioskRouteProps = {
  params: Promise<{ gym_slug: string }>;
};

export async function generateMetadata(props: GymKioskRouteProps): Promise<Metadata> {
  const { gym_slug } = await props.params;
  return buildKioskMetadata(gym_slug, null);
}

export default async function GymKioskPage(props: GymKioskRouteProps) {
  const { gym_slug } = await props.params;
  return <KioskPageRenderer gymSlug={gym_slug} kioskSlug={null} />;
}
