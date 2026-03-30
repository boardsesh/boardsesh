import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Chip from '@mui/material/Chip'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import FavoriteIcon from '@mui/icons-material/Favorite'
import { useState, useEffect, useRef, useCallback } from 'react'
import { graphqlClient } from '@/lib/graphql-client'
import { USER_FAVORITE_CLIMBS } from '@/lib/graphql-queries'
import { useBoardConfig } from '@/lib/board-context'
import type { Climb, ClimbSearchResult } from '@/lib/types'

export const Route = createFileRoute('/b/$slug/$angle/liked')({
  ssr: false,
  component: LikedClimbsPage,
  head: () => ({
    meta: [{ title: 'Liked Climbs | Boardsesh' }],
  }),
})

function LikedClimbsPage() {
  const board = useBoardConfig()
  const { slug, angle: angleStr } = Route.useParams()
  const [page, setPage] = useState(0)

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['userFavoriteClimbs', board.slug, board.angle, page],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        userFavoriteClimbs: ClimbSearchResult
      }>(USER_FAVORITE_CLIMBS, {
        input: {
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
          page,
          pageSize: 30,
        },
      })
      return result.userFavoriteClimbs
    },
  })

  const [accumulatedClimbs, setAccumulatedClimbs] = useState<Climb[]>([])
  const prevPage = useRef(-1)

  useEffect(() => {
    if (!data) return
    if (page === 0) {
      setAccumulatedClimbs(data.climbs)
    } else if (page !== prevPage.current) {
      setAccumulatedClimbs((prev) => [...prev, ...data.climbs])
    }
    prevPage.current = page
  }, [data, page])

  const handleLoadMore = useCallback(() => {
    setPage((p) => p + 1)
  }, [])

  const climbs = accumulatedClimbs
  const hasMore = data?.hasMore ?? false

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', width: '100%' }}>
      <Link
        to="/b/$slug/$angle/list"
        params={{ slug, angle: angleStr }}
        style={{ textDecoration: 'none' }}
      >
        <Button startIcon={<ArrowBackIcon />} size="small" sx={{ mb: 2 }}>
          Back to list
        </Button>
      </Link>

      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FavoriteIcon color="error" />
          <Typography variant="h5" component="h1">
            Liked Climbs
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          {board.name} at {board.angle} degrees
        </Typography>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          Failed to load favorites. Please make sure you are logged in.
        </Alert>
      ) : climbs.length === 0 ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            No liked climbs yet. Browse the climb list and favorite some climbs.
          </Typography>
        </Box>
      ) : (
        <>
          <List disablePadding>
            {climbs.map((climb) => (
              <Link
                key={climb.uuid}
                to="/b/$slug/$angle/view/$climbUuid"
                params={{ slug, angle: angleStr, climbUuid: climb.uuid }}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <ListItemButton
                  sx={{ borderRadius: 1, mb: 0.5, '&:hover': { bgcolor: 'action.hover' } }}
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
              </Link>
            ))}
          </List>

          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <Button
                variant="outlined"
                onClick={handleLoadMore}
                disabled={isFetching}
              >
                {isFetching ? 'Loading...' : 'Load More'}
              </Button>
            </Box>
          )}

          {data?.totalCount != null && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 1 }}
            >
              Showing {climbs.length} of {data.totalCount} liked climbs
            </Typography>
          )}
        </>
      )}
    </Box>
  )
}
