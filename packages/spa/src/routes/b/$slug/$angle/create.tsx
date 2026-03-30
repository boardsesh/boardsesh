import { createFileRoute, Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ConstructionIcon from '@mui/icons-material/Construction'
import { useBoardConfig } from '@/lib/board-context'

export const Route = createFileRoute('/b/$slug/$angle/create')({
  ssr: false,
  component: CreateClimbPage,
  head: () => ({
    meta: [{ title: 'Create Climb | Boardsesh' }],
  }),
})

function CreateClimbPage() {
  const board = useBoardConfig()
  const { slug, angle: angleStr } = Route.useParams()

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

      <Typography variant="h5" component="h1" gutterBottom>
        Create a Climb
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {board.name} at {board.angle} degrees
      </Typography>

      <Card>
        <CardContent
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            py: 6,
          }}
        >
          <ConstructionIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            Coming Soon
          </Typography>
          <Typography variant="body2" color="text.secondary" textAlign="center">
            The climb creation interface is being ported to the new SPA.
            For now, please use the original web app to create climbs.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  )
}
