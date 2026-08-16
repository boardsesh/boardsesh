'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import type { Map as LeafletMap, LayerGroup as LeafletLayerGroup } from 'leaflet';
import type * as LeafletNamespace from 'leaflet';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { themeTokens } from '@/app/theme/theme-config';
import { boardChips } from './directory-card-model';
import { clusterPins, type MapPin, type PinCluster } from './near-me-model';

/**
 * OpenStreetMap's tile policy requires visible attribution. It is a legal
 * notice about a third party, not product copy, so it is not translated and
 * not something a locale is allowed to drop.
 */
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

const MAP_HEIGHT = 420;

type GymDirectoryMapProps = {
  /** The gyms with a pin in the result set on screen. Memoized by the caller. */
  pins: MapPin[];
  /** Pill numerator/denominator: pinned gyms out of gyms shown. */
  pinnedCount: number;
  shownCount: number;
  locale: Locale;
};

/** Leaflet popups take an HTML string, so every interpolated value is escaped. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * A Leaflet map of the gyms currently on screen.
 *
 * Three things here are load-bearing and none of them are stylistic:
 *
 *  - **Leaflet is imported at runtime, inside an effect, only once the
 *    container has a real size.** A Leaflet map initialised in a zero-size
 *    container computes its tile grid against 0x0 and renders grey forever, and
 *    below the breakpoint this map is `display: none`, so nothing should be
 *    downloaded for it at all. A `next/dynamic` or module-scope import ships
 *    the bundle to every visitor of a page most of them never open the map on.
 *  - **`ResizeObserver`, not a `setTimeout`.** The reveal transition, the
 *    breakpoint change and a window resize are all the same event to this
 *    component: the container got a size, or a different one. The first
 *    non-zero size initialises; every later one calls `invalidateSize()`.
 *  - **`attributionControl: true`.** The private board-location picker turns it
 *    off; a public page may not.
 */
export default function GymDirectoryMap({ pins, pinnedCount, shownCount, locale }: GymDirectoryMapProps) {
  const { t } = useTranslation('gyms');
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof LeafletNamespace | null>(null);
  const markerLayerRef = useRef<LeafletLayerGroup | null>(null);
  const [ready, setReady] = useState(false);

  const clusters = useMemo(() => clusterPins(pins), [pins]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    // Torn down in the cleanup and read by the async import continuation, so a
    // StrictMode double-invoke cannot leave a second map attached to a
    // container the first one already claimed.
    let disposed = false;
    let initialising = false;

    const initialise = () => {
      if (initialising || mapRef.current) return;
      initialising = true;

      void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([leaflet]) => {
        if (disposed || !containerRef.current || mapRef.current) return;

        const map = leaflet
          .map(containerRef.current, {
            zoomControl: true,
            // OSM's tile policy is not optional on a public page.
            attributionControl: true,
            scrollWheelZoom: false,
          })
          .setView([25, 0], 2);

        leaflet.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);

        leafletRef.current = leaflet;
        mapRef.current = map;
        markerLayerRef.current = leaflet.layerGroup().addTo(map);
        setReady(true);
      });
    };

    const observer = new ResizeObserver((entries) => {
      const hasSize = entries.some((entry) => entry.contentRect.width > 0 && entry.contentRect.height > 0);
      if (!hasSize) return;
      if (mapRef.current) {
        // Covers the toggle reveal, the breakpoint crossing and a plain window
        // resize with one line, and with no guessed delay.
        mapRef.current.invalidateSize();
        return;
      }
      initialise();
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      leafletRef.current = null;
      setReady(false);
    };
  }, []);

  // Markers are a separate pass so switching between browse and near-me results
  // redraws pins instead of tearing down and re-initialising the map.
  useEffect(() => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!ready || !leaflet || !map || !layer) return;

    layer.clearLayers();

    for (const cluster of clusters) {
      layer.addLayer(buildMarker(leaflet, cluster, { locale, t }));
    }

    if (clusters.length > 0) {
      map.fitBounds(
        leaflet.latLngBounds(clusters.map((cluster) => [cluster.latitude, cluster.longitude] as [number, number])),
        { padding: [32, 32], maxZoom: 13 },
      );
    }
  }, [clusters, ready, locale, t]);

  return (
    <Box sx={{ position: 'relative' }}>
      <Box
        ref={containerRef}
        role="region"
        aria-label={t('map.regionLabel')}
        data-testid="gym-directory-map"
        sx={{
          width: '100%',
          height: MAP_HEIGHT,
          borderRadius: `${themeTokens.borderRadius.lg}px`,
          border: '1px solid var(--neutral-200)',
          overflow: 'hidden',
          backgroundColor: 'var(--semantic-surface)',
        }}
      />
      {/* The honest pill: partial pin coverage stated on the surface that has
          the gap, not buried in a footnote. */}
      <Chip
        size="small"
        label={t('map.pinnedPill', { pinned: pinnedCount, total: shownCount, count: shownCount })}
        sx={{
          position: 'absolute',
          top: themeTokens.spacing[2],
          left: themeTokens.spacing[2],
          zIndex: themeTokens.zIndex.dropdown,
          backgroundColor: 'var(--semantic-surface)',
          borderRadius: `${themeTokens.borderRadius.full}px`,
        }}
      />
    </Box>
  );
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function buildMarker(
  leaflet: typeof LeafletNamespace,
  cluster: PinCluster,
  context: { locale: Locale; t: TranslateFn },
) {
  const { locale, t } = context;

  if (!cluster.pin) {
    const icon = leaflet.divIcon({
      className: '',
      html: `<div style="display:flex;align-items:center;justify-content:center;min-width:32px;height:32px;padding:0 6px;background:var(--color-primary-fill);color:#fff;border:2px solid #fff;border-radius:9999px;box-shadow:0 1px 4px rgba(0,0,0,0.4);font-size:12px;font-weight:600;">${cluster.count}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    return leaflet
      .marker([cluster.latitude, cluster.longitude], {
        icon,
        title: t('map.clusterLabel', { count: cluster.count }),
      })
      .bindPopup(`<strong>${escapeHtml(t('map.clusterLabel', { count: cluster.count }))}</strong>`);
  }

  const pin = cluster.pin;
  // Leaflet's default marker icon is a bundled PNG that 404s under a hashed
  // asset pipeline, so every marker is a divIcon.
  const icon = leaflet.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;background:var(--color-primary-fill);border:3px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  // Locale-prefixed by hand: Leaflet builds this anchor outside React, so
  // `LocaleLink` cannot, and a bare `/gym/x` would bounce a `/de/gyms` visitor
  // into English.
  const href = escapeHtml(localeHref(`/gym/${pin.slug}`, locale));
  const chips = boardChips(pin.boardSummaries)
    .map((chip) =>
      chip.angle > 0
        ? t('card.boardChip', { board: boardTypeLabel(chip.boardType), angle: chip.angle })
        : boardTypeLabel(chip.boardType),
    )
    .join(' · ');

  const popup = [
    `<a href="${href}" style="font-weight:600;">${escapeHtml(pin.name)}</a>`,
    chips ? `<div style="margin-top:4px;">${escapeHtml(chips)}</div>` : '',
  ].join('');

  return leaflet.marker([pin.latitude, pin.longitude], { icon, title: pin.name }).bindPopup(popup);
}
