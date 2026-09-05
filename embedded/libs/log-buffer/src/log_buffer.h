// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef LOG_BUFFER_H
#define LOG_BUFFER_H

#include <Arduino.h>

#define LOG_BUFFER_SIZE 2048

class LogBuffer {
  public:
    LogBuffer();

    void log(const char* format, ...);
    void logln(const char* format, ...);

    void clear();
    String getBuffer();
    size_t getSize();

    void enableSerial(bool enable);

  private:
    char buffer[LOG_BUFFER_SIZE];
    size_t writePos;
    bool serialEnabled;

    void appendToBuffer(const char* str);
};

extern LogBuffer Logger;

#endif
