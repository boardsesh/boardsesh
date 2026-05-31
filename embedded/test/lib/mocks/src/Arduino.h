/**
 * Arduino Mock Header for Native Unit Testing
 *
 * This header provides minimal implementations of Arduino types and functions
 * to allow compiling and testing ESP32 code on a native (host) platform.
 */

#ifndef ARDUINO_MOCK_H
#define ARDUINO_MOCK_H

#include <algorithm>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <type_traits>

// Arduino type definitions
typedef uint8_t byte;
typedef bool boolean;

// Arduino min/max - defined as templates to avoid conflicts with std::min/max
// Note: Arduino defines these as macros, but that causes issues with STL
// Use inline functions for compatibility. Return by value to avoid dangling references.
#ifndef ARDUINO_MIN_MAX_DEFINED
#define ARDUINO_MIN_MAX_DEFINED

template <typename T, typename U>
inline typename std::common_type<T, U>::type min(T a, U b) {
    return (a < b) ? a : b;
}

template <typename T, typename U>
inline typename std::common_type<T, U>::type max(T a, U b) {
    return (a > b) ? a : b;
}

#endif

#define constrain(x, low, high) ((x) < (low) ? (low) : ((x) > (high) ? (high) : (x)))
#define lowByte(w) ((uint8_t)((w) & 0xff))
#define highByte(w) ((uint8_t)((w) >> 8))

// Pin modes
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2

// Digital values
#define LOW 0
#define HIGH 1

// Time functions (mock implementations)
inline unsigned long millis() {
    return 0;
}
inline unsigned long micros() {
    return 0;
}
inline void delay(unsigned long ms) {
    (void)ms;
}
inline void delayMicroseconds(unsigned int us) {
    (void)us;
}

// Random functions (mock implementations)
inline long random(long max) {
    (void)max;
    return 0;
}
inline long random(long min, long max) {
    (void)min;
    (void)max;
    return min;
}

// Pin functions (mock implementations)
inline void pinMode(uint8_t pin, uint8_t mode) {
    (void)pin;
    (void)mode;
}
inline void digitalWrite(uint8_t pin, uint8_t val) {
    (void)pin;
    (void)val;
}
inline int digitalRead(uint8_t pin) {
    (void)pin;
    return 0;
}
inline int analogRead(uint8_t pin) {
    (void)pin;
    return 0;
}
inline void analogWrite(uint8_t pin, int val) {
    (void)pin;
    (void)val;
}

// memset declaration (in case not available from cstring)
using std::memcpy;
using std::memmove;
using std::memset;
using std::strlen;

/**
 * Mock String class compatible with Arduino String
 */
class String {
  public:
    String() : data_("") {}
    String(const char* str) : data_(str ? str : "") {}
    String(const String& other) : data_(other.data_) {}
    String(int value) : data_(std::to_string(value)) {}
    String(unsigned int value) : data_(std::to_string(value)) {}
    String(long value) : data_(std::to_string(value)) {}
    String(unsigned long value) : data_(std::to_string(value)) {}
    String(float value, int decimalPlaces = 2) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%.*f", decimalPlaces, value);
        data_ = buf;
    }

    const char* c_str() const { return data_.c_str(); }
    size_t length() const { return data_.length(); }
    bool isEmpty() const { return data_.empty(); }

    String& operator=(const String& rhs) {
        data_ = rhs.data_;
        return *this;
    }
    String& operator=(const char* str) {
        data_ = str ? str : "";
        return *this;
    }

    String operator+(const String& rhs) const { return String((data_ + rhs.data_).c_str()); }
    String operator+(const char* rhs) const { return String((data_ + (rhs ? rhs : "")).c_str()); }
    String& operator+=(const String& rhs) {
        data_ += rhs.data_;
        return *this;
    }
    String& operator+=(const char* rhs) {
        if (rhs)
            data_ += rhs;
        return *this;
    }
    String& operator+=(char c) {
        data_ += c;
        return *this;
    }

    bool operator==(const String& rhs) const { return data_ == rhs.data_; }
    bool operator==(const char* rhs) const { return data_ == (rhs ? rhs : ""); }
    bool operator!=(const String& rhs) const { return data_ != rhs.data_; }
    bool operator<(const String& rhs) const { return data_ < rhs.data_; }

    char charAt(unsigned int index) const {
        if (index < data_.length())
            return data_[index];
        return 0;
    }

    char operator[](unsigned int index) const { return charAt(index); }

    int indexOf(char c) const {
        size_t pos = data_.find(c);
        return pos == std::string::npos ? -1 : (int)pos;
    }

    int indexOf(const String& str) const {
        size_t pos = data_.find(str.data_);
        return pos == std::string::npos ? -1 : (int)pos;
    }

    String substring(unsigned int beginIndex) const {
        if (beginIndex >= data_.length())
            return String();
        return String(data_.substr(beginIndex).c_str());
    }

    String substring(unsigned int beginIndex, unsigned int endIndex) const {
        if (beginIndex >= data_.length())
            return String();
        return String(data_.substr(beginIndex, endIndex - beginIndex).c_str());
    }

    bool startsWith(const String& prefix) const {
        if (prefix.length() > data_.length())
            return false;
        return data_.compare(0, prefix.length(), prefix.c_str()) == 0;
    }

    bool startsWith(const char* prefix) const {
        if (!prefix)
            return false;
        size_t prefixLen = strlen(prefix);
        if (prefixLen > data_.length())
            return false;
        return data_.compare(0, prefixLen, prefix) == 0;
    }

    bool endsWith(const String& suffix) const {
        if (suffix.length() > data_.length())
            return false;
        return data_.compare(data_.length() - suffix.length(), suffix.length(), suffix.c_str()) == 0;
    }

    bool endsWith(const char* suffix) const {
        if (!suffix)
            return false;
        size_t suffixLen = strlen(suffix);
        if (suffixLen > data_.length())
            return false;
        return data_.compare(data_.length() - suffixLen, suffixLen, suffix) == 0;
    }

    void remove(unsigned int index) {
        if (index < data_.length()) {
            data_.erase(index);
        }
    }

    void toCharArray(char* buf, size_t bufsize) const {
        if (buf && bufsize > 0) {
            size_t len = (bufsize - 1 < data_.length()) ? bufsize - 1 : data_.length();
            memcpy(buf, data_.c_str(), len);
            buf[len] = '\0';
        }
    }

  private:
    std::string data_;
};

/**
 * Mock Serial class for print output
 */
class MockSerial {
  public:
    void begin(unsigned long baud) { (void)baud; }
    void end() {}

    size_t print(const char* str) {
        if (str)
            printf("%s", str);
        return str ? strlen(str) : 0;
    }
    size_t print(const String& str) { return print(str.c_str()); }
    size_t print(int val) { return printf("%d", val); }
    size_t print(unsigned int val) { return printf("%u", val); }
    size_t print(long val) { return printf("%ld", val); }
    size_t print(unsigned long val) { return printf("%lu", val); }
    size_t print(double val, int = 2) { return printf("%f", val); }
    size_t print(char c) { return printf("%c", c); }

    size_t println() { return printf("\n"); }
    size_t println(const char* str) { return printf("%s\n", str ? str : ""); }
    size_t println(const String& str) { return println(str.c_str()); }
    size_t println(int val) { return printf("%d\n", val); }
    size_t println(unsigned int val) { return printf("%u\n", val); }
    size_t println(long val) { return printf("%ld\n", val); }
    size_t println(unsigned long val) { return printf("%lu\n", val); }
    size_t println(double val, int = 2) { return printf("%f\n", val); }

    size_t printf(const char* format, ...) {
        va_list args;
        va_start(args, format);
        int ret = vprintf(format, args);
        va_end(args);
        return ret > 0 ? ret : 0;
    }

    int available() { return 0; }
    int read() { return -1; }
    int peek() { return -1; }
    void flush() {}
};

extern MockSerial Serial;

#endif  // ARDUINO_MOCK_H
