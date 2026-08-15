'use client';

import React from 'react';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiTooltip from '@mui/material/Tooltip';

type HoldIndicatorProps = {
  count: number;
  max?: number;
  color: string;
  label: string;
};

export default function HoldIndicator({ count, max, color, label }: HoldIndicatorProps) {
  const active = count > 0;
  return (
    <MuiTooltip title={label}>
      <Stack direction="row" alignItems="center" spacing={0.5} aria-label={label} sx={{ cursor: 'default' }}>
        <Box
          sx={(theme) => {
            let opacity = 1;
            if (!active) {
              opacity = theme.palette.mode === 'dark' ? 0.4 : 0.25;
            }
            return {
              width: 10,
              height: 10,
              borderRadius: '50%',
              backgroundColor: color,
              opacity,
              flexShrink: 0,
            };
          }}
        />
        <Typography
          variant="caption"
          sx={{
            fontWeight: 600,
            lineHeight: 1,
            color: active ? color : 'text.disabled',
            minWidth: '1.5ch',
          }}
        >
          {max !== undefined ? `${count}/${max}` : String(count)}
        </Typography>
      </Stack>
    </MuiTooltip>
  );
}
