import { describe, expect, it } from 'vite-plus/test';
import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  GYM_MCP_DEFAULT_SCOPES,
  GYM_MCP_ADMIN_SCOPES,
  parseGymMcpMode,
} from '../partner-oauth';

describe('hosted gym MCP contract', () => {
  it('keeps unknown configuration disabled', () => {
    for (const configured of [undefined, '', 'enabled', 'all', 'true']) expect(parseGymMcpMode(configured)).toBe('off');
    expect(parseGymMcpMode(' PILOT ')).toBe('pilot');
    expect(parseGymMcpMode('ON')).toBe('on');
  });
  it('has a separate resource and no personal training-data scopes', () => {
    expect(GYM_MCP_RESOURCE).toBe('https://api.boardsesh.com/mcp/gyms');
    expect(GYM_MCP_DEFAULT_SCOPES).toEqual(['gyms:read', 'gyms:write', 'gyms:access:write', 'offline_access']);
    expect(GYM_MCP_ADMIN_SCOPES).toEqual(['gyms:admin:read', 'gyms:admin:write']);
    expect(GYM_MCP_SCOPES).toEqual([...GYM_MCP_DEFAULT_SCOPES, ...GYM_MCP_ADMIN_SCOPES]);
  });
});
