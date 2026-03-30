import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Button from '@mui/material/Button'
import { useState } from 'react'
import { graphqlClient } from '@/lib/graphql-client'
import { SETTER_PROFILE, SETTER_CLIMBS } from '@/lib/graphql-queries'
import type { SetterProfile, SetterClimbsConnection } from '@/lib/types'

export const Route = createFileRoute('/setter/$username')({
  ssr: true,
  component: SetterProfilePage,
  head: ({ params }) => ({
    meta: [
      { title: `${params.username} - Setter Profile | Boardsesh` },
      { name: 'og:title', content: `${params.username} - Setter Profile | Boardsesh` },
      { name: 'og:url', content: `/setter/${params.username}` },
      { name: 'og:description', content: `View climbs set by ${params.username} on Boardsesh` },
    ],
  }),
})

function SetterProfilePage() {
  const { username } = Route.useParams()
  const [offset, setOffset] = useState(0)
  const pageSize = 30

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['setterProfile', username],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        setterProfile: SetterProfile | null
      }>(SETTER_PROFILE, { input: { username } })
      return result.setterProfile
    },
  })

  const { data: climbsData, isFetching } = useQuery({
    queryKey: ['setterClimbs', username, offset],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        setterClimbs: SetterClimbsConnection
      }>(SETTER_CLIMBS, {
        input: {
          username,
          sortBy: 'popular',
          limit: pageSize,
          offset,
        },
      })
      return result.setterClimbs
    },
    enabled: !!profile,
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error || !profile) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
        <Alert severity="error">
          {error ? 'Failed to load setter profile.' : 'Setter not found.'}
        </Alert>
      </Box>
    )
  }

  const climbs = climbsData?.climbs ?? []
  const hasMore = climbsData?.hasMore ?? false

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', width: '100%', p: 2 }}>
      {/* Profile header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Avatar
          src={profile.linkedUserAvatarUrl ?? undefined}
          alt={username}
          sx={{ width: 64, height: 64 }}
        >
          {username[0].toUpperCase()}
        </Avatar>
        <Box>
          <Typography variant="h5" component="h1">
            {username}
          </Typography>
          {profile.linkedUserDisplayName && (
            <Typography variant="body2" color="text.secondary">
              {profile.linkedUserDisplayName}
            </Typography>
          )}
          <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
            <Chip label={`${profile.climbCount} climbs`} size="small" variant="outlined" />
            <Chip label={`${profile.followerCount} followers`} size="small" variant="outlined" />
          </Box>
        </Box>
      </Box>

      {/* Board types */}
      {profile.boardTypes.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.5, mb: 2 }}>
          {profile.boardTypes.map((bt) => (
            <Chip key={bt} label={bt} size="small" color="primary" variant="outlined" />
          ))}
        </Box>
      )}

      {/* Climbs list */}
      <Card>
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Climbs by {username}
          </Typography>

          {climbs.length === 0 && !isFetching ? (
            <Typography variant="body2" color="text.secondary">
              No climbs found.
            </Typography>
          ) : (
            <List disablePadding>
              {climbs.map((climb) => (
                <ListItemButton
                  key={climb.uuid}
                  sx={{ borderRadius: 1, mb: 0.5 }}
                >
                  <ListItemText
                    primary={climb.name ?? 'Unnamed'}
                    secondary={`${climb.boardType} - ${climb.difficultyName ?? 'Ungraded'}`}
                    slotProps={{ primary: { noWrap: true } }}
                  />
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 1, flexShrink: 0 }}>
                    {climb.difficultyName && (
                      <Chip
                        label={climb.difficultyName}
                        size="small"
                        color="primary"
                        variant="outlined"
                      />
                    )}
                    {climb.ascensionistCount != null && (
                      <Typography variant="caption" color="text.secondary">
                        {climb.ascensionistCount} sends
                      </Typography>
                    )}
                  </Box>
                </ListItemButton>
              ))}
            </List>
          )}

          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 2 }}>
              <Button
                variant="outlined"
                onClick={() => setOffset((o) => o + pageSize)}
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
              sx={{ textAlign: 'center', pt: 1 }}
            >
              {climbsData.totalCount} total climbs
            </Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  )
}
