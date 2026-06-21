# Boardsesh Backend

WebSocket server for Boardsesh Party Mode. Provides reliable real-time synchronization for multi-user climbing queue management.

## Quick Start with Docker

```bash
# Start the backend with PostgreSQL
docker-compose up -d

# The backend will be available at ws://localhost:8080
```

## Manual Setup

### Prerequisites

- Node.js 22+
- PostgreSQL 16+

### Installation

```bash
# Install dependencies
bun install

# Set up environment
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/boardsesh_backend"

# Run database migrations
bun run db:migrate

# Start in development mode
bun run dev

# Or build and run in production
bun run build
bun start
```

## Configuration

Environment variables:

| Variable              | Default                                                           | Description                                              |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `PORT`                | `8080`                                                            | WebSocket server port                                    |
| `DATABASE_URL`        | `postgresql://postgres:postgres@localhost:5432/boardsesh_backend` | PostgreSQL connection string                             |
| `POSTHOG_PROJECT_KEY` | `NEXT_PUBLIC_POSTHOG_KEY`, then unset                             | Enables backend PostHog events for Live Activity usage   |
| `POSTHOG_HOST`        | `https://us.i.posthog.com`                                        | PostHog ingestion host                                   |
| `POSTHOG_ENVIRONMENT` | `SENTRY_ENVIRONMENT`, then `NODE_ENV`, then `development`         | Event environment property for backend PostHog analytics |

## Network Setup

For other devices on your network to connect:

1. Find your local IP address:
   - macOS/Linux: `ifconfig` or `ip addr`
   - Windows: `ipconfig`

2. Use the backend URL in Boardsesh: `ws://YOUR_IP:8080`

Example: `ws://192.168.1.100:8080`

## Production Deployment with WSS (Traefik)

For secure WebSocket connections over the internet, deploy behind a reverse proxy with TLS termination.

### Architecture

```
Internet
    ↓
Traefik (TLS termination, Let's Encrypt)
    ↓ (ws://backend:8080)
Boardsesh Backend
    ↓
PostgreSQL
```

### Traefik Configuration

Add to your Traefik dynamic configuration:

```yaml
http:
  routers:
    boardsesh-backend:
      rule: 'Host(`boardsesh-ws.yourdomain.com`)'
      entryPoints:
        - websecure
      service: boardsesh-backend
      tls:
        certResolver: letsencrypt

  services:
    boardsesh-backend:
      loadBalancer:
        servers:
          - url: 'http://backend-internal-ip:8080'
```

### Docker Compose for Production

```yaml
services:
  backend:
    image: ghcr.io/boardsesh/boardsesh-backend:latest
    # No ports exposed - only accessible via Traefik
    environment:
      - DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/boardsesh_backend
      - PORT=8080
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - traefik # Your Traefik network
      - internal

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=boardsesh_backend
    volumes:
      - backend_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - internal

networks:
  traefik:
    external: true
  internal:
    driver: bridge

volumes:
  backend_data:
```

### Usage

Once deployed, users connect via:

```
https://boardsesh.com?backendUrl=wss://boardsesh-ws.yourdomain.com
```

The `backendUrl` is configured via the `NEXT_PUBLIC_WS_URL` environment variable.

## API

The backend exposes GraphQL over HTTP and WebSocket at `/graphql`. Party mode uses the `graphql-ws` protocol so session mutations and subscriptions share one connection context.

Primary WebSocket operations:

- `joinSession(sessionId, boardPath, participantId, ...)`: joins or restores a party session. `participantId` is a stable anonymous participant ID; authenticated clients use their user ID.
- `leaveSession`: explicit UI leave. Passive WebSocket disconnects do not call this path.
- `endSession`: explicit finish. WebSocket callers must be the session creator or current leader; HTTP callers must be the authenticated session creator.
- Queue mutations: `addQueueItem`, `removeQueueItem`, `setQueue`, `setCurrentClimb`, `mirrorCurrentClimb`.
- Subscriptions: `queueUpdates(sessionId)` and `sessionUpdates(sessionId)`.

Passive disconnects mark participants `RECONNECTING`, elect a new leader immediately when needed, and keep the session recoverable during the reconnect grace period. See [docs/websocket-implementation.md](../../docs/websocket-implementation.md) for the current protocol and failure-recovery details.
