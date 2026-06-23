'use client';

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import MapOutlined from '@mui/icons-material/MapOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MyLocationOutlined from '@mui/icons-material/MyLocationOutlined';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import type * as LeafletNamespace from 'leaflet';
import { useGeolocation } from '@/app/hooks/use-geolocation';

type NominatimResult = {
  lat: string;
  lon: string;
  display_name: string;
};

type MapLocationPickerProps = {
  latitude: number | null;
  longitude: number | null;
  onChange: (lat: number, lng: number) => void;
};

export default function MapLocationPicker({ latitude, longitude, onChange }: MapLocationPickerProps) {
  const { t } = useTranslation('boards');
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const leafletRef = useRef<typeof LeafletNamespace | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const { coordinates: userCoords, requestPermission } = useGeolocation();
  const [expanded, setExpanded] = useState(latitude != null && longitude != null);
  const [mapReady, setMapReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const placeMarker = useCallback((lat: number, lng: number) => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    } else {
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;background:#6d28d9;border:3px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      markerRef.current = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const pos = markerRef.current!.getLatLng();
        onChangeRef.current(Math.round(pos.lat * 1000000) / 1000000, Math.round(pos.lng * 1000000) / 1000000);
      });
    }
  }, []);

  // Initialize map once the accordion is expanded
  useEffect(() => {
    if (!expanded || !containerRef.current) return;

    // Guard against React strict mode double-mount
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      markerRef.current = null;
      leafletRef.current = null;
    }

    void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([L]) => {
      if (!containerRef.current) return;

      const hasCoords = latitude != null && longitude != null;
      let center: [number, number] = [40, -95];
      if (hasCoords) {
        center = [latitude, longitude];
      } else if (userCoords) {
        center = [userCoords.latitude, userCoords.longitude];
      }
      const zoom = hasCoords || userCoords ? 14 : 3;

      const map = L.map(containerRef.current, {
        zoomControl: true,
        attributionControl: false,
      }).setView(center, zoom);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(map);

      leafletRef.current = L;
      mapRef.current = map;
      setMapReady(true);

      // Place initial marker if coordinates exist
      if (hasCoords) {
        placeMarker(latitude, longitude);
      }

      // Click to place/move marker
      map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
        const lat = Math.round(e.latlng.lat * 1000000) / 1000000;
        const lng = Math.round(e.latlng.lng * 1000000) / 1000000;
        placeMarker(lat, lng);
        onChangeRef.current(lat, lng);
      });

      // Fix size after accordion transition
      setTimeout(() => map.invalidateSize(), 100);
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        leafletRef.current = null;
        setMapReady(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const handleUseMyLocation = useCallback(() => {
    if (userCoords) {
      const lat = Math.round(userCoords.latitude * 1000000) / 1000000;
      const lng = Math.round(userCoords.longitude * 1000000) / 1000000;
      placeMarker(lat, lng);
      mapRef.current?.flyTo([lat, lng], 14);
      onChangeRef.current(lat, lng);
    } else {
      void requestPermission();
    }
  }, [userCoords, placeMarker, requestPermission]);

  // Invalidate map size when accordion expands
  const handleAccordionChange = useCallback((_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded);
    if (isExpanded && mapRef.current) {
      setTimeout(() => mapRef.current?.invalidateSize(), 200);
    }
  }, []);

  const handleAddressSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (!query.trim()) return;

      searchTimerRef.current = setTimeout(async () => {
        setIsSearching(true);
        try {
          const encoded = encodeURIComponent(query.trim());
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encoded}`, {
            headers: { 'Accept-Language': 'en' },
          });
          if (!res.ok) {
            console.error('Nominatim search failed:', res.status, res.statusText);
            return;
          }
          const results: NominatimResult[] = await res.json();
          if (results.length > 0) {
            const lat = Math.round(parseFloat(results[0].lat) * 1000000) / 1000000;
            const lng = Math.round(parseFloat(results[0].lon) * 1000000) / 1000000;
            placeMarker(lat, lng);
            mapRef.current?.flyTo([lat, lng], 16);
            onChangeRef.current(lat, lng);
          }
        } catch (error) {
          console.error('Address search failed:', error);
        } finally {
          setIsSearching(false);
        }
      }, 500);
    },
    [placeMarker],
  );

  // Cleanup search timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const hasLocation = latitude != null && longitude != null;

  return (
    <Accordion
      expanded={expanded}
      onChange={handleAccordionChange}
      variant="outlined"
      disableGutters
      sx={{ '&:before': { display: 'none' }, borderRadius: 1 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <MapOutlined fontSize="small" color="action" />
          <MuiTypography variant="body2">
            {hasLocation
              ? t('mapLocationPicker.locationDisplay', {
                  lat: latitude.toFixed(4),
                  lng: longitude.toFixed(4),
                })
              : t('mapLocationPicker.setOnMap')}
          </MuiTypography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        <Box sx={{ px: 1.5, pt: 1, pb: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t('mapLocationPicker.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleAddressSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchOutlined fontSize="small" color="action" />
                  </InputAdornment>
                ),
                endAdornment: isSearching ? (
                  <InputAdornment position="end">
                    <CircularProgress size={16} />
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
        </Box>
        <Box sx={{ position: 'relative' }}>
          <div ref={containerRef} style={{ width: '100%', height: 200, borderRadius: '0 0 4px 4px' }} />
          {mapReady && (
            <MuiButton
              size="small"
              variant="contained"
              startIcon={<MyLocationOutlined />}
              onClick={handleUseMyLocation}
              sx={{
                position: 'absolute',
                bottom: 8,
                right: 8,
                zIndex: 1000,
                fontSize: '0.75rem',
                textTransform: 'none',
              }}
            >
              {t('mapLocationPicker.myLocation')}
            </MuiButton>
          )}
        </Box>
        <MuiTypography variant="caption" color="text.secondary" sx={{ px: 2, py: 1, display: 'block' }}>
          {t('mapLocationPicker.helpText')}
        </MuiTypography>
      </AccordionDetails>
    </Accordion>
  );
}
