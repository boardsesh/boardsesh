import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import PublicIcon from '@mui/icons-material/Public'
import LockIcon from '@mui/icons-material/Lock'
import { useState } from 'react'
import { graphqlClient } from '@/lib/graphql-client'
import { PLAYLIST, PLAYLIST_CLIMBS } from '@/lib/graphql-queries'
import type { Playlist, Climb, ClimbSearchResult } from '@/lib/types'

export const Route = createFileRoute('/playlists/$uuid')({
  ssr: false,
  component: PlaylistDetailPage,
  head: () => ({
    meta: [{ title: 'Playlist | Boardsesh' }],
  }),
})

function PlaylistDetailPage() {
  const { uuid } = Route.useParams()
  const [page, setPage] = useState(0)

  const { data: playlist, isLoading: playlistLoading, error: playlistError } = useQuery({
    queryKey: ['playlist', uuid],
    queryFn: async () => {
      const result = await graphqlClient.request<{ playlist: Playlist | null }>(PLAYLIST, {
        playlistId: uuid,
      })
      return result.playlist
    },
  })

  const { data: climbsData, isLoading: climbsLoading, isFetching } = useQuery({
    queryKey: ['playlistClimbs', uuid, page],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        playlistClimbs: ClimbSearchResult
      }>(PLAYLIST_CLIMBS, {
        input: {
          playlistId: uuid,
          page,
          pageSize: 30,
        },
      })
      return result.playlistClimbs
    },
    enabled: !!playlist,
  })

  if (playlistLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (playlistError || !playlist) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
        <Alert severity="error">
          {playlistError ? 'Failed to load playlist.' : 'Playlist not found.'}
        </Alert>
        <Link to="/playlists" style={{ textDecoration: 'none' }}>
          <Button startIcon={<ArrowBackIcon />} sx={{ mt: 2 }}>
            Back to playlists
          </Button>
        </Link>
      </Box>
    )
  }

  const climbs = climbsData?.climbs ?? []
  const hasMore = climbsData?.hasMore ?? false

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', width: '100%', p: 2 }}>
      <Link to="/playlists" style={{ textDecoration: 'none' }}>
        <Button startIcon={<ArrowBackIcon />} size="small" sx={{ mb: 2 }}>
          Back to playlists
        </Button>
      </Link>

      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="h5" component="h1">
            {playlist.name}
          </Typography>
          {playlist.isPublic ? (
            <PublicIcon fontSize="small" color="action" />
          ) : (
            <LockIcon fontSize="small" color="action" />
          )}
        </Box>
        {playlist.description && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {playlist.description}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Chip label={playlist.boardType} size="small" variant="outlined" />
          <Chip label={`${playlist.climbCount} climbs`} size="small" variant="outlined" />
          {playlist.followerCount > 0 && (
            <Chip label={`${playlist.followerCount} followers`} size="small" variant="outlined" />
          )}
        </Box>
      </Box>

      {climbsLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : climbs.length === 0 ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            This playlist has no climbs yet.
          </Typography>
        </Box>
      ) : (
        <>
          <List disablePadding>
            {climbs.map((climb: Climb) => (
              <ListItemButton
                key={climb.uuid}
                sx={{ borderRadius: 1, mb: 0.5 }}
              >
                <ListItemText
                  primary={climb.name}
                  secondary={`by ${climb.setter_username}`}
                  slotProps={{ primary: { noWrap: true } }}
                />
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 1, flexShrink: 0 }}>
                  <Chip
                    label={climb.difficulty}
                    size="small"
                    color="primary"
                    variant="outlined"
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'right' }}>
                    {climb.ascensionist_count} sends
                  </Typography>
                </Box>
              </ListItemButton>
            ))}
          </List>

          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <Button
                variant="outlined"
                onClick={() => setPage((p) => p + 1)}
                disabled={isFetching}
              >
                {isFetching ? 'Loading...' : 'Load More'}
              </Button>
            </Box>
          )}

          {climbsData?.totalCount != null && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 1 }}
            >
              Showing {climbs.length} of {climbsData.totalCount} climbs
            </Typography>
          )}
        </>
      )}
    </Box>
  )
}
