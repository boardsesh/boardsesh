'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import AddOutlined from '@mui/icons-material/AddOutlined';

import { getPreference, setPreference, type Esp32Connection } from '@/app/lib/user-preferences-db';
import type { BoardConfigData } from '@/app/lib/server-board-configs';

import AddEsp32Dialog from './components/add-esp32-dialog';
import Esp32Tab from './components/esp32-tab';

const ADD_TAB = 'ADD';

type DevelopmentContentProps = {
  boardConfigs: BoardConfigData;
};

// The dev-mode guard lives in page.tsx (notFound() server-side) so production
// requests never reach this client component. We don't repeat it here.
export default function DevelopmentContent({ boardConfigs }: DevelopmentContentProps) {
  const [connections, setConnections] = useState<Esp32Connection[]>([]);
  const [active, setActive] = useState<string>(ADD_TAB);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load persisted connections on mount.
  useEffect(() => {
    let cancelled = false;
    void getPreference<Esp32Connection[]>('esp32Connections').then((list) => {
      if (cancelled) return;
      const safe = Array.isArray(list) ? list : [];
      setConnections(safe);
      setActive(safe.length > 0 ? safe[0].id : ADD_TAB);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist any change.
  useEffect(() => {
    if (!loaded) return;
    void setPreference('esp32Connections', connections);
  }, [connections, loaded]);

  const handleTabChange = (_: React.SyntheticEvent, value: string): void => {
    if (value === ADD_TAB) {
      openAddDialog();
      return;
    }
    setActive(value);
  };

  // The "+" tab needs its own onClick because MUI's Tabs onChange does not fire
  // when the clicked value already equals `value` — which happens whenever the
  // connections list is empty (ADD_TAB is the only/active tab).
  const openAddDialog = (): void => {
    setEditingId(null);
    setDialogOpen(true);
  };

  const handleSubmit = (conn: Esp32Connection): void => {
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === conn.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = conn;
        return next;
      }
      return [...prev, conn];
    });
    setActive(conn.id);
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleEdit = (id: string): void => {
    setEditingId(id);
    setDialogOpen(true);
  };

  const handleRemove = (id: string): void => {
    setConnections((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (active === id) setActive(next[0]?.id ?? ADD_TAB);
      return next;
    });
  };

  const editingConnection = editingId ? connections.find((c) => c.id === editingId) : undefined;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // The bottom tab bar and queue control bar are hidden on /development
        // (see RootBottomBar), so we only need to clear the global header.
        marginTop: 'var(--global-header-height)',
        height: 'calc(100vh - var(--global-header-height))',
      }}
    >
      <Box sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Tabs
          value={connections.some((c) => c.id === active) || active === ADD_TAB ? active : ADD_TAB}
          onChange={handleTabChange}
          variant="scrollable"
          scrollButtons="auto"
        >
          {connections.map((conn) => (
            <Tab key={conn.id} value={conn.id} label={conn.label || conn.ip} sx={{ textTransform: 'none' }} />
          ))}
          {/* i18n-ignore-next-line -- internal dev tool, English only */}
          <Tab value={ADD_TAB} icon={<AddOutlined />} aria-label="Add ESP32" onClick={openAddDialog} />
        </Tabs>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {connections.length === 0 ? (
          <Box sx={{ p: 4 }}>
            <Typography variant="h6" gutterBottom>
              {/* i18n-ignore-next-line -- internal dev tool, English only */}
              No ESP32 emulators yet
            </Typography>
            <Typography color="text.secondary">
              {/* i18n-ignore-next-line -- internal dev tool, English only */}
              Click the <strong>+</strong> tab to add one. Flash the firmware from
              {/* i18n-ignore-next-line -- internal dev tool, English only */}
              <code> packages/board-controller/esp32/ </code> with <code>pio run -e esp32-emulator -t upload</code> and
              enter the hostname or IP it logs at boot.
            </Typography>
          </Box>
        ) : (
          // All tabs are mounted in parallel — only the active one is visible.
          // This keeps every WebSocket open in the background so payloads still
          // arrive when you switch back. (Standard `TabPanel` unmounts.)
          connections.map((conn) => (
            <Esp32Tab
              key={conn.id}
              connection={conn}
              active={active === conn.id}
              onEdit={() => handleEdit(conn.id)}
              onRemove={() => handleRemove(conn.id)}
            />
          ))
        )}
      </Box>

      <AddEsp32Dialog
        open={dialogOpen}
        boardConfigs={boardConfigs}
        initial={editingConnection}
        onClose={() => {
          setDialogOpen(false);
          setEditingId(null);
        }}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
