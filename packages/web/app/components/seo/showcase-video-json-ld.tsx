import React from 'react';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { showcaseVideoJsonLd } from '@/app/lib/showcase-video';

/** `VideoObject` for the hero video. The caller renders it for en-US only. */
export default function ShowcaseVideoJsonLd() {
  return <JsonLd data={showcaseVideoJsonLd()} />;
}
