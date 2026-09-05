// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "log_buffer.h"
#include <string.h>

// Global log buffer instance
LogBuffer logBuffer;

LogBuffer::LogBuffer()
    : head(0), tail(0), entryCount(0) {
    // Initialize buffer to zeros
    memset(buffer, 0, sizeof(buffer));
}

void LogBuffer::push(const char* level, const char* component, const char* message) {
    // Get current write position
    size_t writePos = head;

    // Fill in the entry
    LogEntry& entry = buffer[writePos];
    entry.timestamp = millis();

    // Copy level (with truncation protection)
    strncpy(entry.level, level, LOG_LEVEL_MAX_LEN - 1);
    entry.level[LOG_LEVEL_MAX_LEN - 1] = '\0';

    // Copy component (with truncation protection)
    strncpy(entry.component, component, LOG_COMPONENT_MAX_LEN - 1);
    entry.component[LOG_COMPONENT_MAX_LEN - 1] = '\0';

    // Copy message (with truncation protection)
    strncpy(entry.message, message, LOG_MESSAGE_MAX_LEN - 1);
    entry.message[LOG_MESSAGE_MAX_LEN - 1] = '\0';

    // Advance head (wrap around)
    head = (writePos + 1) % LOG_BUFFER_SIZE;

    // Update count
    if (entryCount < LOG_BUFFER_SIZE) {
        entryCount++;
    } else {
        // Buffer is full, advance tail to discard oldest
        tail = head;
    }
}

size_t LogBuffer::drain(LogEntry* dest, size_t maxCount) {
    size_t drained = 0;

    while (drained < maxCount && entryCount > 0) {
        // Copy entry from tail position
        memcpy(&dest[drained], &buffer[tail], sizeof(LogEntry));

        // Advance tail (wrap around)
        tail = (tail + 1) % LOG_BUFFER_SIZE;
        entryCount--;
        drained++;
    }

    return drained;
}

size_t LogBuffer::count() const {
    return entryCount;
}

bool LogBuffer::isEmpty() const {
    return entryCount == 0;
}

void LogBuffer::clear() {
    head = 0;
    tail = 0;
    entryCount = 0;
}
