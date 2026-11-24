import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { GymMcpPrincipal } from './auth';
import { createGymMcpContext, executeGymMcpWriteAction, hasGymMcpWriteReceipt } from './dispatch';
import { executeGymDocument, resolveGymForTool } from './domain';
import { prepareGymMcpImage, type PreparedGymImage } from './media';
import { gymMcpToolFailure, recordGymMcpToolResult } from './tool-result';
import { trackGymMcpToolWork } from './request-lifetime';
import { getGymImageSource, gymImageAttributionSchema, recordGymImageSource } from './media-source';
import { GYM_MCP_MEDIA_TOOLS } from './media-tool-metadata';

const { getImageSource, setImage, removeImage } = GYM_MCP_MEDIA_TOOLS;

const imageIdentity = {
  gymUuid: z.uuid().describe('The gym UUID returned by the gym tools.'),
  kind: z.enum(['photo', 'logo']),
  idempotencyKey: z.uuid().describe('Reuse the same UUID and arguments only when retrying this exact change.'),
};

export function registerGymMcpMediaTools(server: McpServer, principal: GymMcpPrincipal): void {
  if (principal.scopes.includes(getImageSource.scope)) {
    server.registerTool(
      getImageSource.name,
      {
        description:
          'Read the currently saved gym photo/logo URL and its recorded import source and credit. Requires gym edit access and gyms:read. Older or web-uploaded images can have no recorded source.',
        inputSchema: z.object({ gymUuid: imageIdentity.gymUuid, kind: imageIdentity.kind }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (arguments_) =>
        trackGymMcpToolWork(async () => {
          const startedAt = performance.now();
          try {
            const gym = await resolveGymForTool(arguments_.gymUuid, principal.userId);
            const result = await getGymImageSource(
              gym.uuid,
              arguments_.kind,
              (arguments_.kind === 'photo' ? gym.imageUrl : gym.logoUrl) ?? null,
            );
            recordGymMcpToolResult(getImageSource.name, 'success', startedAt);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
          } catch (error) {
            return gymMcpToolFailure(error, getImageSource.name, startedAt);
          }
        }),
    );
  }
  if (principal.scopes.includes(setImage.scope)) {
    server.registerTool(
      setImage.name,
      {
        description:
          'Requires gyms:write and gym edit access. Replace a gym photo or logo from a public HTTPS JPG, PNG, GIF, or WebP URL. Photos up to 5 MB; logos up to 2 MB. The URL must return the image directly. Supply attribution with source page, credit and license when known; read it back with get_gym_image_source. For a file on your device, use get_gym_upload_links and the gym page uploader.',
        inputSchema: z
          .object({
            ...imageIdentity,
            imageUrl: z.url().max(2048),
            attribution: gymImageAttributionSchema.optional(),
            confirm: z.literal(true),
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      (arguments_, requestContext) =>
        trackGymMcpToolWork(async () => {
          const startedAt = performance.now();
          let prepared: PreparedGymImage | undefined;
          try {
            requestContext.mcpReq.signal.throwIfAborted();
            if (!(await hasGymMcpWriteReceipt(principal, arguments_.idempotencyKey))) {
              prepared = await prepareGymMcpImage(
                principal,
                arguments_.gymUuid,
                arguments_.kind,
                arguments_.imageUrl,
                requestContext.mcpReq.signal,
              );
            }
            requestContext.mcpReq.signal.throwIfAborted();
            const uploadedImage = prepared;
            const result = await executeGymMcpWriteAction(
              principal,
              setImage.name,
              arguments_,
              setImage.scope,
              async () => {
                if (!uploadedImage) throw new Error('The previous upload is unavailable. Start a new image change.');
                const storedUrl = uploadedImage.storedUrl;
                const gym = await resolveGymForTool(arguments_.gymUuid, principal.userId, true, true);
                await executeGymDocument(
                  'updateGym',
                  {
                    input: {
                      gymUuid: gym.uuid,
                      [arguments_.kind === 'photo' ? 'imageUrl' : 'logoUrl']: storedUrl,
                    },
                  },
                  createGymMcpContext(principal),
                );
                await recordGymImageSource({
                  gymId: gym.id,
                  gymUuid: gym.uuid,
                  actorUserId: principal.userId,
                  kind: arguments_.kind,
                  previousUrl: (arguments_.kind === 'photo' ? gym.imageUrl : gym.logoUrl) ?? null,
                  storedUrl,
                  source: {
                    imageUrl: arguments_.imageUrl,
                    ...(arguments_.attribution ? { attribution: arguments_.attribution } : {}),
                  },
                });
                return { gymUuid: gym.uuid, kind: arguments_.kind, storedUrl };
              },
              async () => {
                await resolveGymForTool(arguments_.gymUuid, principal.userId, true, true);
              },
            );
            if (prepared && result.storedUrl !== prepared.storedUrl) await prepared.discard();
            prepared = undefined;
            recordGymMcpToolResult(setImage.name, 'success', startedAt);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
          } catch (error) {
            try {
              await prepared?.discard();
            } catch {
              // Staged cleanup must not hide the action failure or its outcome event.
            }
            return gymMcpToolFailure(error, setImage.name, startedAt);
          }
        }),
    );
  }
  if (principal.scopes.includes(removeImage.scope)) {
    server.registerTool(
      removeImage.name,
      {
        description:
          'Remove the displayed gym photo or logo. Confirm the selected image should disappear. Existing gym permissions apply.',
        inputSchema: z.object({ ...imageIdentity, confirm: z.literal(true) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      (arguments_, requestContext) =>
        trackGymMcpToolWork(async () => {
          const startedAt = performance.now();
          try {
            requestContext.mcpReq.signal.throwIfAborted();
            const result = await executeGymMcpWriteAction(
              principal,
              removeImage.name,
              arguments_,
              removeImage.scope,
              async () => {
                const gym = await resolveGymForTool(arguments_.gymUuid, principal.userId, true, true);
                await executeGymDocument(
                  'updateGym',
                  {
                    input: {
                      gymUuid: gym.uuid,
                      [arguments_.kind === 'photo' ? 'imageUrl' : 'logoUrl']: null,
                    },
                  },
                  createGymMcpContext(principal),
                );
                await recordGymImageSource({
                  gymId: gym.id,
                  gymUuid: gym.uuid,
                  actorUserId: principal.userId,
                  kind: arguments_.kind,
                  previousUrl: (arguments_.kind === 'photo' ? gym.imageUrl : gym.logoUrl) ?? null,
                  storedUrl: null,
                  source: null,
                });
                return { gymUuid: gym.uuid, kind: arguments_.kind, storedUrl: null };
              },
              async () => {
                await resolveGymForTool(arguments_.gymUuid, principal.userId, true, true);
              },
            );
            recordGymMcpToolResult(removeImage.name, 'success', startedAt);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
          } catch (error) {
            return gymMcpToolFailure(error, removeImage.name, startedAt);
          }
        }),
    );
  }
}
