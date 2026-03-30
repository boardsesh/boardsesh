import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import CircularProgress from '@mui/material/CircularProgress'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import CardActionArea from '@mui/material/CardActionArea'
import Divider from '@mui/material/Divider'
import { useSession, signOut } from '@/lib/auth-client'
import { graphqlClient } from '@/lib/graphql-client'
import { gql } from 'graphql-request'

export const Route = createFileRoute('/')({
  component: HomePage,
})

interface MyBoard {
  uuid: string
  slug: string
  boardType: string
  name: string
  angle: number
  layoutName: string | null
  sizeName: string | null
}

const MY_BOARDS = gql`
  query MyBoards {
    myBoards(input: { limit: 10 }) {
      boards {
        uuid
        slug
        boardType
        name
        angle
        layoutName
        sizeName
      }
    }
  }
`

function HomePage() {
  const { data: session, isPending } = useSession()

  const { data: boardsData, isLoading: boardsLoading } = useQuery({
    queryKey: ['myBoards'],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        myBoards: { boards: MyBoard[] }
      }>(MY_BOARDS)
      return result.myBoards.boards
    },
    enabled: !!session?.user,
  })

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 3,
          textAlign: 'center',
        }}
      >
        <Typography variant="h3" component="h1" fontWeight="bold">
          Boardsesh
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Interactive climbing training board control
        </Typography>

        {isPending ? (
          <CircularProgress size={24} />
        ) : session?.user ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', width: '100%' }}>
            <Typography variant="body1">
              Signed in as <strong>{session.user.email}</strong>
            </Typography>
            {session.user.name && (
              <Typography variant="body2" color="text.secondary">
                {session.user.name}
              </Typography>
            )}

            {/* My Boards section */}
            <Divider sx={{ width: '100%', my: 1 }} />
            <Typography variant="h6">My Boards</Typography>

            {boardsLoading ? (
              <CircularProgress size={24} />
            ) : boardsData && boardsData.length > 0 ? (
              <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
                {boardsData.map((board) => (
                  <Link
                    key={board.uuid}
                    to="/b/$slug/$angle/list"
                    params={{ slug: board.slug, angle: String(board.angle) }}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <Card variant="outlined">
                      <CardActionArea>
                        <CardContent sx={{ py: 1.5 }}>
                          <Typography variant="subtitle1">
                            {board.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {board.boardType} {board.layoutName && `/ ${board.layoutName}`}{' '}
                            {board.sizeName && `/ ${board.sizeName}`} / {board.angle} deg
                          </Typography>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Link>
                ))}
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                No boards yet. Create one to get started.
              </Typography>
            )}

            <Button
              variant="outlined"
              onClick={() => {
                void signOut()
              }}
              sx={{ mt: 1 }}
            >
              Sign Out
            </Button>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              component={Link}
              to="/auth/login"
              variant="contained"
              color="primary"
            >
              Sign In
            </Button>
            <Button
              component={Link}
              to="/auth/register"
              variant="outlined"
              color="primary"
            >
              Register
            </Button>
          </Box>
        )}
      </Box>
    </Container>
  )
}
