'use client';

import BluetoothSearching from '@mui/icons-material/BluetoothSearching';
import Bluetooth from '@mui/icons-material/Bluetooth';
import SignalCellularAlt from '@mui/icons-material/SignalCellularAlt';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DiscoveredDevice } from '@/app/lib/ble/types';

interface DevicePickerDialogProps {
  devices: DiscoveredDevice[];
  onSelect: (deviceId: string) => void;
  onCancel: () => void;
}

function signalLabel(rssi: number): string {
  if (rssi >= -50) return 'Strong';
  if (rssi >= -70) return 'Good';
  if (rssi >= -85) return 'Weak';
  return 'Very weak';
}

export function DevicePickerDialog({ devices, onSelect, onCancel }: DevicePickerDialogProps) {
  // Sort by signal strength (strongest first)
  const sorted = [...devices].sort((a, b) => b.rssi - a.rssi);

  return (
    <Dialog open onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <BluetoothSearching />
          <span>Select your board</span>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ minHeight: 120 }}>
        {sorted.length === 0 ? (
          <Stack direction="row" alignItems="center" spacing={2} sx={{ py: 3, justifyContent: 'center' }}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              Scanning for boards nearby&hellip;
            </Typography>
          </Stack>
        ) : (
          <List disablePadding>
            {sorted.map((device) => (
              <ListItemButton key={device.deviceId} onClick={() => onSelect(device.deviceId)}>
                <ListItemIcon sx={{ minWidth: 40 }}>
                  <Bluetooth />
                </ListItemIcon>
                <ListItemText
                  primary={device.name || 'Unknown device'}
                  secondary={
                    <Stack direction="row" alignItems="center" spacing={0.5} component="span">
                      <SignalCellularAlt sx={{ fontSize: 14 }} />
                      <span>{signalLabel(device.rssi)}</span>
                    </Stack>
                  }
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
