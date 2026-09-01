/**
 * OpenAPI Specification Generator
 *
 * This module generates the complete OpenAPI specification document
 * by combining the registry with metadata about the API.
 *
 * The generated spec is used by:
 * - Swagger UI for interactive documentation
 * - Client SDK generation
 * - API validation tools
 */

import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './openapi-registry';

// Import routes to register them with the registry
import './openapi-routes';

/** The value when it names an https origin, otherwise undefined. */
function httpsOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.startsWith('https://') ? trimmed : undefined;
}

// Register security scheme
registry.registerComponent('securitySchemes', 'session', {
  type: 'apiKey',
  in: 'cookie',
  name: 'next-auth.session-token',
  description: 'NextAuth session cookie',
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Boardsesh REST API',
      version: '1.0.0',
      description: `
# Boardsesh API Documentation

Boardsesh provides APIs for interacting with interactive climbing training boards (Kilter, Tension).
This documentation covers the REST API endpoints.

## API Overview

### Public Endpoints
- **Board Configuration**: Get grades, angles, and board setup information
- **Climbs**: Search and retrieve climb data, statistics, and beta videos
- **Slug Resolution**: Convert human-readable URLs to numeric IDs

### Authenticated Endpoints
- **User Profile**: Manage user settings and preferences

### WebSocket API
For real-time features like queue synchronization and party sessions, see the [GraphQL WebSocket documentation](/docs#graphql).

## Authentication

Most read operations are public. Write operations and personal data require authentication via NextAuth session cookies.

For WebSocket connections, obtain a JWT token from \`/api/internal/ws-auth\` and include it in the connection parameters.

## Rate Limiting

Registration and authentication endpoints are rate-limited to prevent abuse. Rate limit headers are included in responses.

## Board Types

Currently supported boards:
- \`kilter\` - Kilter Board
- \`tension\` - Tension Board

## URL Structure

Board-specific endpoints follow this pattern:
\`\`\`
/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/...
\`\`\`

Layout, size, and set IDs can be either numeric IDs or human-readable slugs.
      `.trim(),
      contact: {
        name: 'Boardsesh',
        url: 'https://github.com/marcodejongh/boardsesh',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        // The deployment's canonical origin first — VERCEL_URL is the
        // per-deployment hostname, which is neither stable nor present off
        // Vercel (#4651). The https gate matters: this file runs under
        // `vp run generate:openapi` at BUILD time; its Node launcher explicitly
        // loads the tracked packages/web/.env.local, which supplies a loopback
        // BASE_URL and NEXTAUTH_URL. Without the gate a production build would bake
        // `http://localhost:3000` into the public /docs schema.
        // TODO(#4656): drop the VERCEL_URL term with the project.
        url:
          httpsOrigin(process.env.BASE_URL) ??
          httpsOrigin(process.env.NEXTAUTH_URL) ??
          (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
        description: 'Current server',
      },
    ],
    tags: [
      {
        name: 'Board Configuration',
        description: 'Endpoints for retrieving board configuration like grades and angles',
      },
      {
        name: 'Climbs',
        description: 'Endpoints for searching and retrieving climb data',
      },
      {
        name: 'Slug Resolution',
        description: 'Convert human-readable slugs to numeric IDs',
      },
      {
        name: 'Authentication',
        description: 'User registration and authentication',
      },
      {
        name: 'User Profile',
        description: 'User profile management (requires authentication)',
      },
      {
        name: 'WebSocket',
        description: 'WebSocket authentication and configuration',
      },
    ],
  });
}

export type OpenAPIDocument = ReturnType<typeof generateOpenApiDocument>;
