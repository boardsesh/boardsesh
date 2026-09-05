// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef LOG_BUFFER_H
#define LOG_BUFFER_H

#include <Arduino.h>

// Buffer configuration
#define LOG_BUFFER_SIZE 50
#define LOG_MESSAGE_MAX_LEN 128
#define LOG_COMPONENT_MAX_LEN 8
#define LOG_LEVEL_MAX_LEN 8

/**
 * Single log entry stored in the ring buffer
 */
struct LogEntry {
    unsigned long timestamp;              // millis() at log time
    char level[LOG_LEVEL_MAX_LEN];       // "DEBUG", "INFO", "WARN", "ERROR"
    char component[LOG_COMPONENT_MAX_LEN]; // "BLE", "WS", "WiFi", "LED"
    char message[LOG_MESSAGE_MAX_LEN];   // Log message
};

/**
 * Ring buffer for storing device logs
 *
 * Thread-safe for single producer, single consumer pattern.
 * Logs are pushed from various components and drained periodically
 * by the WebSocket client for sending to the backend.
 */
class LogBuffer {
public:
    LogBuffer();

    /**
     * Push a new log entry to the buffer
     * If buffer is full, oldest entry is overwritten
     *
     * @param level Log level (DEBUG, INFO, WARN, ERROR)
     * @param component Component name (BLE, WS, WiFi, LED)
     * @param message Log message (will be truncated if too long)
     */
    void push(const char* level, const char* component, const char* message);

    /**
     * Drain log entries from the buffer
     *
     * @param dest Destination array to copy entries to
     * @param maxCount Maximum number of entries to drain
     * @return Number of entries actually drained
     */
    size_t drain(LogEntry* dest, size_t maxCount);

    /**
     * Get current number of entries in the buffer
     */
    size_t count() const;

    /**
     * Check if buffer is empty
     */
    bool isEmpty() const;

    /**
     * Clear all entries from the buffer
     */
    void clear();

private:
    LogEntry buffer[LOG_BUFFER_SIZE];
    volatile size_t head;  // Next write position
    volatile size_t tail;  // Next read position
    volatile size_t entryCount;
};

// Global log buffer instance
extern LogBuffer logBuffer;

#endif // LOG_BUFFER_H
