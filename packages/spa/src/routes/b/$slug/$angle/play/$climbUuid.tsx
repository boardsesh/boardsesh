import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import InfoIcon from '@mui/icons-material/Info'
import { graphqlClient } from '@/lib/graphql-client'
import { CLIMB_DETAIL } from '@/lib/graphql-queries'
import { useBoardConfig } from '@/lib/board-context'
import type { ClimbDetail } from '@/lib/types'

export const Route = createFileRoute('/b/$slug/$angle/play/$climbUuid')({
  component: PlayPage,
  head: ({ params }) => ({
    meta: [
      { title: `Play | Boardsesh` },
      { name: 'og:title', content: `Playing climb on Boardsesh` },
      {
        name: 'og:url',
        content: `/b/${params.slug}/${params.angle}/play/${params.climbUuid}`,
      },
    ],
  }),
})

function PlayPage() {
  const { slug, angle: angleStr, climbUuid } = Route.useParams()
  const board = useBoardConfig()

  const {
    data: climb,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['climbDetail', board.boardType, climbUuid],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        climbDetail: ClimbDetail | null
      }>(CLIMB_DETAIL, {
        boardName: board.boardType,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
        climbUuid,
      })
      return result.climbDetail
    },
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error || !climb) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
        <Alert severity="error">
          {error ? 'Failed to load climb.' : 'Climb not found.'}
        </Alert>
        <Link
          to="/b/$slug/$angle/list"
          params={{ slug, angle: angleStr }}
          style={{ textDecoration: 'none' }}
        >
          <Button startIcon={<ArrowBackIcon />} sx={{ mt: 2 }}>
            Back to list
          </Button>
        </Link>
      </Box>
    )
  }

  return (
    <Box
      sx={{
        maxWidth: 800,
        mx: 'auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {/* Navigation */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link
          to="/b/$slug/$angle/list"
          params={{ slug, angle: angleStr }}
          style={{ textDecoration: 'none' }}
        >
          <Button startIcon={<ArrowBackIcon />} size="small">
            List
          </Button>
        </Link>
        <Link
          to="/b/$slug/$angle/view/$climbUuid"
          params={{ slug, angle: angleStr, climbUuid }}
          style={{ textDecoration: 'none' }}
        >
          <Button startIcon={<InfoIcon />} size="small">
            Details
          </Button>
        </Link>
      </Box>

      {/* Climb info card */}
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Box>
              <Typography variant="h5" component="h1">
                {climb.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                by {climb.setter_username}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
              <Chip label={climb.difficulty} color="primary" />
              <Chip
                label={`${board.angle} deg`}
                variant="outlined"
                size="small"
              />
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Play area placeholder - board rendering comes in M4 */}
      <Card
        sx={{
          aspectRatio: '3/4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ textAlign: 'center', p: 3 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            Board View
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Board rendering and Bluetooth control will be available in a future
            milestone.
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {Object.keys(climb.litUpHoldsMap).length} holds to light up
          </Typography>
        </Box>
      </Card>

      {/* Description */}
      {climb.description && (
        <Typography variant="body2" color="text.secondary">
          {climb.description}
        </Typography>
      )}
    </Box>
  )
}
