import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import ListItemIcon from '@mui/material/ListItemIcon'
import Chip from '@mui/material/Chip'
import QueueMusicIcon from '@mui/icons-material/QueueMusic'
import PublicIcon from '@mui/icons-material/Public'
import LockIcon from '@mui/icons-material/Lock'
import { graphqlClient } from '@/lib/graphql-client'
import { ALL_USER_PLAYLISTS } from '@/lib/graphql-queries'
import type { Playlist } from '@/lib/types'

export const Route = createFileRoute('/playlists/')({
  ssr: false,
  component: PlaylistsPage,
  head: () => ({
    meta: [{ title: 'Playlists | Boardsesh' }],
  }),
})

function PlaylistsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['allUserPlaylists'],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        allUserPlaylists: Playlist[]
      }>(ALL_USER_PLAYLISTS, {
        input: {},
      })
      return result.allUserPlaylists
    },
  })

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', width: '100%', p: 2 }}>
      <Typography variant="h5" component="h1" gutterBottom>
        My Playlists
      </Typography>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          Failed to load playlists. Please make sure you are logged in.
        </Alert>
      ) : !data || data.length === 0 ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <QueueMusicIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
          <Typography variant="body1" color="text.secondary">
            You don't have any playlists yet.
          </Typography>
        </Box>
      ) : (
        <List disablePadding>
          {data.map((playlist) => (
            <Link
              key={playlist.uuid}
              to="/playlists/$uuid"
              params={{ uuid: playlist.uuid }}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <ListItemButton
                sx={{
                  borderRadius: 1,
                  mb: 0.5,
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <ListItemIcon sx={{ minWidth: 40 }}>
                  {playlist.isPublic ? (
                    <PublicIcon fontSize="small" color="action" />
                  ) : (
                    <LockIcon fontSize="small" color="action" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={playlist.name}
                  secondary={`${playlist.boardType} - ${playlist.climbCount} climbs`}
                  slotProps={{ primary: { noWrap: true } }}
                />
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 1, flexShrink: 0 }}>
                  <Chip
                    label={playlist.boardType}
                    size="small"
                    variant="outlined"
                  />
                  {playlist.followerCount > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      {playlist.followerCount} followers
                    </Typography>
                  )}
                </Box>
              </ListItemButton>
            </Link>
          ))}
        </List>
      )}
    </Box>
  )
}
