// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Device Logging Types (ESP32 → Axiom)

// A single log entry from a device
export type DeviceLogEntry = {
  ts: number;
  level: string;
  component: string;
  message: string;
  metadata?: string; // JSON string for flexibility
};

// Input for sending device logs
export type SendDeviceLogsInput = {
  logs: DeviceLogEntry[];
};

// Response from sending device logs
export type SendDeviceLogsResponse = {
  success: boolean;
  accepted: number;
};
