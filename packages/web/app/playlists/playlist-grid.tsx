import React from 'react';
import Box from '@mui/material/Box';
import type { DiscoverablePlaylist } from '@boardsesh/graphql/operations';
import PlaylistLinkCard from '@/app/components/playlists/playlist-link-card';
import styles from './playlists.module.css';

/**
 * A grid of playlist cards. Server-rendered: `PlaylistLinkCard` is a client
 * component only because it reads a translation, and a client leaf still renders
 * on the server — so the cards are in the first HTML a crawler sees, which is
 * the whole point of this page being indexable.
 */
export default function PlaylistGrid({
  playlists,
  basePath = '/playlists',
  priorityCount = 0,
}: {
  playlists: DiscoverablePlaylist[];
  basePath?: string;
  /** Cards above the fold get `fetchPriority="high"` for their preview square. */
  priorityCount?: number;
}) {
  return (
    <Box component="ul" className={styles.cardGrid}>
      {playlists.map((playlist, index) => (
        <Box component="li" key={playlist.uuid} className={styles.cardGridItem}>
          <PlaylistLinkCard
            name={playlist.name}
            climbCount={playlist.climbCount}
            boardType={playlist.boardType}
            layoutId={playlist.layoutId}
            color={playlist.color ?? undefined}
            icon={playlist.icon ?? undefined}
            href={`${basePath}/${playlist.uuid}`}
            index={index}
            fetchPriority={index < priorityCount ? 'high' : 'auto'}
          />
        </Box>
      ))}
    </Box>
  );
}
