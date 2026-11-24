import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { GymMcpPrincipal } from './auth';
import { createGymMcpContext, executeGymMcpWriteAction, hasGymMcpWriteReceipt } from './dispatch';
import { executeGymDocument, resolveGymForTool } from './domain';
import { prepareGymMcpImage, type PreparedGymImage } from './media';
import { gymMcpToolFailure, recordGymMcpToolResult } from './tool-result';
import { trackGymMcpToolWork } from './request-lifetime';

const imageIdentity = {
  gymUuid: z.uuid().describe('The gym UUID returned by the gym tools.'),
  kind: z.enum(['photo', 'logo']),
  idempotencyKey: z.uuid().describe('Reuse the same UUID and arguments only when retrying this exact change.'),
};

export function registerGymMcpMediaTools(server: McpServer, principal: GymMcpPrincipal): void {
  if (!principal.scopes.includes('gyms:write')) return;
  server.registerTool(
    'set_gym_image',
    {
      description:
        'Replace a gym photo or logo from a public HTTPS JPG, PNG, GIF, or WebP URL. Photos up to 5 MB; logos up to 2 MB. The URL must return the image directly. For a file on your device, use get_gym_upload_links and the gym page uploader.',
      inputSchema: z.object({ ...imageIdentity, imageUrl: z.url().max(2048), confirm: z.literal(true) }),
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
            'set_gym_image',
            arguments_,
            'gyms:write',
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
              return { gymUuid: gym.uuid, kind: arguments_.kind, storedUrl };
            },
            async () => {
              await resolveGymForTool(arguments_.gymUuid, principal.userId, true, true);
            },
          );
          if (prepared && result.storedUrl !== prepared.storedUrl) await prepared.discard();
          prepared = undefined;
          recordGymMcpToolResult('set_gym_image', 'success', startedAt);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          try {
            await prepared?.discard();
          } catch {
            // Staged cleanup must not hide the action failure or its outcome event.
          }
          return gymMcpToolFailure(error, 'set_gym_image', startedAt);
        }
      }),
  );
  server.registerTool(
    'remove_gym_image',
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
            'remove_gym_image',
            arguments_,
            'gyms:write',
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
              return { gymUuid: gym.uuid, kind: arguments_.kind, storedUrl: null };
            },
            async () => {
              await resolveGymForTool(arguments_.gymUuid, principal.userId, true, true);
            },
          );
          recordGymMcpToolResult('remove_gym_image', 'success', startedAt);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          return gymMcpToolFailure(error, 'remove_gym_image', startedAt);
        }
      }),
  );
}
