import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/my-library')({
  beforeLoad: () => {
    throw redirect({ to: '/playlists' })
  },
  component: () => null,
})
