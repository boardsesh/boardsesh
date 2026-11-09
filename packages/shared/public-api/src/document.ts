import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { API_ORIGIN, createPublicApiRegistry } from './registry';

export function generatePublicApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const generator = new OpenApiGeneratorV31(createPublicApiRegistry().definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Boardsesh API',
      version: '1.0.0',
      description:
        "Read a climber's Boardsesh logbook with their consent. Draft v1. JSON, UTF-8, camelCase, timestamps are RFC 3339 in UTC, ids are strings. Additive changes ship on v1 without notice: read what you know and ignore the rest.",
    },
    servers: [{ url: API_ORIGIN }],
  });
}

/** The committed `openapi.json`, byte for byte. */
export function renderPublicApiDocument(): string {
  return `${JSON.stringify(generatePublicApiDocument(), null, 2)}\n`;
}
