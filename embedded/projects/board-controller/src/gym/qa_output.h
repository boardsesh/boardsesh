#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace gym_fixture {

// Three boards of at most 1024 decoded commands fit below this bound. Refuse
// incomplete/oversized frames before emitting even the tag.
constexpr size_t MAX_QA_LINE_BYTES = 192 * 1024;
constexpr char QA_LINE_PREFIX[] = "BOARDSESH_QA ";

inline size_t qaFrameLength(size_t jsonLength) {
    constexpr size_t overhead = sizeof(QA_LINE_PREFIX);  // Prefix plus newline.
    return jsonLength <= MAX_QA_LINE_BYTES - overhead ? jsonLength + overhead : 0;
}

template <typename Serializer>
size_t buildQaFrame(char* frame, size_t capacity, size_t jsonLength, Serializer serialize) {
    const size_t length = qaFrameLength(jsonLength);
    if (!frame || length == 0 || capacity <= length)
        return 0;
    constexpr size_t prefixLength = sizeof(QA_LINE_PREFIX) - 1;
    std::memcpy(frame, QA_LINE_PREFIX, prefixLength);
    // Give serializers an isolated JSON span: ArduinoJson 7 String writers
    // replace their destination instead of appending to a pre-existing prefix.
    if (serialize(frame + prefixLength, jsonLength + 1) != jsonLength)
        return 0;
    frame[length - 1] = '\n';
    frame[length] = '\0';
    return length;
}

template <typename Output> bool writeQaLine(Output& output, const char* frame, size_t length) {
    if (!frame || length == 0 || length > MAX_QA_LINE_BYTES || frame[length - 1] != '\n')
        return false;

    // HWCDC accepts bytes into a queue and its ISR drains them later. A stdout
    // lock around this call cannot exclude IDF's secondary USB console during
    // that deferred drain. The gym target compiles NimBLE console logs out at
    // their source. Other exceptional console output still fails the strict
    // host parser; accepting a full write is not proof of wire completion.
    return output.write(reinterpret_cast<const uint8_t*>(frame), length) == length;
}

}  // namespace gym_fixture
