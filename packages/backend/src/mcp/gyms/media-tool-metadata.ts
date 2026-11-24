/** Shared by actual registration, scope discovery and hidden-call refusals. */
export const GYM_MCP_MEDIA_TOOLS = {
  getImageSource: { name: 'get_gym_image_source', scope: 'gyms:read', category: 'profile' },
  setImage: { name: 'set_gym_image', scope: 'gyms:write', category: 'profile' },
  removeImage: { name: 'remove_gym_image', scope: 'gyms:write', category: 'profile' },
} as const;

export const gymMcpMediaToolMetadata = Object.values(GYM_MCP_MEDIA_TOOLS);
