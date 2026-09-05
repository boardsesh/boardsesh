// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "log_buffer.h"

#include <stdarg.h>

LogBuffer Logger;

LogBuffer::LogBuffer() : writePos(0), serialEnabled(true) {
    memset(buffer, 0, LOG_BUFFER_SIZE);
}

void LogBuffer::log(const char* format, ...) {
    char temp[256];
    va_list args;
    va_start(args, format);
    vsnprintf(temp, sizeof(temp), format, args);
    va_end(args);

    appendToBuffer(temp);

    if (serialEnabled) {
        Serial.print(temp);
    }
}

void LogBuffer::logln(const char* format, ...) {
    char temp[256];
    va_list args;
    va_start(args, format);
    vsnprintf(temp, sizeof(temp), format, args);
    va_end(args);

    appendToBuffer(temp);
    appendToBuffer("\n");

    if (serialEnabled) {
        Serial.println(temp);
    }
}

void LogBuffer::clear() {
    memset(buffer, 0, LOG_BUFFER_SIZE);
    writePos = 0;
}

String LogBuffer::getBuffer() {
    return String(buffer);
}

size_t LogBuffer::getSize() {
    return writePos;
}

void LogBuffer::enableSerial(bool enable) {
    serialEnabled = enable;
}

void LogBuffer::appendToBuffer(const char* str) {
    size_t len = strlen(str);

    if (writePos + len >= LOG_BUFFER_SIZE - 1) {
        // Ring buffer wrap - shift content
        size_t shift = (writePos + len) - (LOG_BUFFER_SIZE - 1) + LOG_BUFFER_SIZE / 4;
        if (shift < writePos) {
            memmove(buffer, buffer + shift, writePos - shift);
            writePos -= shift;
        } else {
            writePos = 0;
        }
    }

    memcpy(buffer + writePos, str, len);
    writePos += len;
    buffer[writePos] = '\0';
}
