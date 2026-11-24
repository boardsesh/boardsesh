'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import { GYM_MCP_ENDPOINT } from '@/app/lib/gym-mcp/endpoint';

type EndpointCopyProps = { label: string; copy: string; copied: string; failed: string };

export default function EndpointCopy({ label, copy, copied, failed }: EndpointCopyProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(GYM_MCP_ENDPOINT);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1.5 }}>
      <TextField
        label={label}
        value={GYM_MCP_ENDPOINT}
        fullWidth
        slotProps={{ input: { readOnly: true } }}
        onFocus={(event) => event.target.select()}
      />
      <Button variant="outlined" startIcon={<ContentCopyOutlined />} onClick={() => void copyEndpoint()}>
        {copy}
      </Button>
      <Typography variant="body2" color="text.secondary" role="status">
        {status === 'copied' ? copied : status === 'failed' ? failed : null}
      </Typography>
    </Box>
  );
}
