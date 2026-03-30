import { useState } from 'react'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { darkTheme } from '@/theme/mui-theme'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#0A0A0A' },
      { title: 'Boardsesh' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider theme={darkTheme}>
            <CssBaseline />
            <Outlet />
          </ThemeProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
