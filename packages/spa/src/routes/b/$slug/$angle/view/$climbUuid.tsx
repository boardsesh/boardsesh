import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Divider from '@mui/material/Divider'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { graphqlClient } from '@/lib/graphql-client'
import { CLIMB_DETAIL, CLIMB_STATS, CLIMB_BETA_LINKS } from '@/lib/graphql-queries'
import { useBoardConfig } from '@/lib/board-context'
import type { ClimbDetail, ClimbStatsForAngle, BetaLink } from '@/lib/types'

export const Route = createFileRoute('/b/$slug/$angle/view/$climbUuid')({
  component: ClimbViewPage,
  head: ({ params }) => ({
    meta: [
      { title: `Climb | Boardsesh` },
      { name: 'og:title', content: `Climb on Boardsesh` },
      {
        name: 'og:url',
        content: `/b/${params.slug}/${params.angle}/view/${params.climbUuid}`,
      },
    ],
  }),
})

function ClimbViewPage() {
  const { slug, angle: angleStr, climbUuid } = Route.useParams()
  const board = useBoardConfig()
  const angle = Number(angleStr)

  const {
    data: climb,
    isLoading: climbLoading,
    error: climbError,
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

  const { data: stats } = useQuery({
    queryKey: ['climbStats', board.boardType, climbUuid],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        climbStats: ClimbStatsForAngle[]
      }>(CLIMB_STATS, {
        boardName: board.boardType,
        climbUuid,
      })
      return result.climbStats
    },
    enabled: !!climb,
  })

  const { data: betaLinks } = useQuery({
    queryKey: ['climbBeta', board.boardType, climbUuid],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        climbBetaLinks: BetaLink[]
      }>(CLIMB_BETA_LINKS, {
        boardName: board.boardType,
        climbUuid,
      })
      return result.climbBetaLinks
    },
    enabled: !!climb,
  })

  if (climbLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (climbError || !climb) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
        <Alert severity="error">
          {climbError ? 'Failed to load climb.' : 'Climb not found.'}
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

  // Find stats for the current angle
  const currentStats = stats?.find((s) => s.angle === angle)

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', width: '100%' }}>
      {/* Back navigation */}
      <Link
        to="/b/$slug/$angle/list"
        params={{ slug, angle: angleStr }}
        style={{ textDecoration: 'none' }}
      >
        <Button startIcon={<ArrowBackIcon />} size="small" sx={{ mb: 2 }}>
          Back to list
        </Button>
      </Link>

      {/* Climb header */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {climb.name}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip label={climb.difficulty} color="primary" />
          <Typography variant="body2" color="text.secondary">
            by {climb.setter_username}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {climb.ascensionist_count} ascents
          </Typography>
          {climb.benchmark_difficulty && (
            <Chip
              label={`Benchmark: ${climb.benchmark_difficulty}`}
              size="small"
              variant="outlined"
              color="warning"
            />
          )}
        </Box>
      </Box>

      {/* Play button */}
      <Link
        to="/b/$slug/$angle/play/$climbUuid"
        params={{ slug, angle: angleStr, climbUuid }}
        style={{ textDecoration: 'none' }}
      >
        <Button
          variant="contained"
          size="large"
          startIcon={<PlayArrowIcon />}
          fullWidth
          sx={{ mb: 3 }}
        >
          Play
        </Button>
      </Link>

      {/* Description */}
      {climb.description && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Description
            </Typography>
            <Typography variant="body2">{climb.description}</Typography>
          </CardContent>
        </Card>
      )}

      {/* Stats at current angle */}
      {currentStats && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Stats at {angle} degrees
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                gap: 2,
              }}
            >
              <StatItem label="Ascents" value={String(currentStats.ascensionistCount)} />
              {currentStats.difficulty && (
                <StatItem label="Community Grade" value={currentStats.difficulty} />
              )}
              {currentStats.qualityAverage != null && (
                <StatItem
                  label="Quality"
                  value={currentStats.qualityAverage.toFixed(1)}
                />
              )}
              {currentStats.faUsername && (
                <StatItem label="First Ascent" value={currentStats.faUsername} />
              )}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Stats across all angles */}
      {stats && stats.length > 1 && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              All Angles
            </Typography>
            {stats.map((stat) => (
              <Box key={stat.angle}>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    py: 0.5,
                  }}
                >
                  <Typography variant="body2">
                    {stat.angle} degrees
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 2 }}>
                    {stat.difficulty && (
                      <Typography variant="body2" color="text.secondary">
                        {stat.difficulty}
                      </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary">
                      {stat.ascensionistCount} ascents
                    </Typography>
                  </Box>
                </Box>
                <Divider />
              </Box>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Beta links */}
      {betaLinks && betaLinks.length > 0 && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Beta Videos
            </Typography>
            {betaLinks.map((beta) => (
              <Box key={beta.link} sx={{ py: 0.5 }}>
                <Typography
                  component="a"
                  href={beta.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                  color="primary"
                  sx={{ textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                >
                  {beta.foreignUsername
                    ? `Beta by ${beta.foreignUsername}`
                    : 'Beta video'}
                  {beta.angle != null && ` (${beta.angle} deg)`}
                </Typography>
              </Box>
            ))}
          </CardContent>
        </Card>
      )}
    </Box>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body1" fontWeight="medium">
        {value}
      </Typography>
    </Box>
  )
}
