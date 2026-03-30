import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import { graphqlClient } from '@/lib/graphql-client'
import { BOARD_BY_SLUG } from '@/lib/graphql-queries'
import { BoardProvider, type BoardConfig } from '@/lib/board-context'
import type { UserBoard } from '@/lib/types'

export const Route = createFileRoute('/b/$slug/$angle')({
  ssr: false,
  component: BoardLayoutRoute,
})

function BoardLayoutRoute() {
  const { slug, angle: angleStr } = Route.useParams()
  const angle = Number(angleStr)

  const {
    data: board,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['board', slug],
    queryFn: async () => {
      const result = await graphqlClient.request<{ boardBySlug: UserBoard | null }>(
        BOARD_BY_SLUG,
        { slug },
      )
      return result.boardBySlug
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  })

  if (isLoading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}
      >
        <CircularProgress />
      </Box>
    )
  }

  if (error || !board) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 8 }}>
        <Alert severity="error">
          <Typography variant="body1">
            {error ? 'Failed to load board configuration.' : 'Board not found.'}
          </Typography>
        </Alert>
      </Box>
    )
  }

  const config: BoardConfig = {
    uuid: board.uuid,
    slug: board.slug,
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    name: board.name,
    angle: Number.isNaN(angle) ? board.angle : angle,
    isAngleAdjustable: board.isAngleAdjustable,
    layoutName: board.layoutName,
    sizeName: board.sizeName,
    sizeDescription: board.sizeDescription,
    setNames: board.setNames,
  }

  return (
    <BoardProvider config={config}>
      <Box
        sx={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          bgcolor: 'background.default',
        }}
      >
        <Box
          component="main"
          sx={{
            flex: 1,
            px: 1,
            pt: 2,
            pb: 4,
          }}
        >
          <Outlet />
        </Box>
      </Box>
    </BoardProvider>
  )
}
