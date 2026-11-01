#include "../../projects/board-controller/src/gym/qa_output.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static unsigned checks = 0;
#define CHECK(expression)                                                      \
    do {                                                                       \
        ++checks;                                                              \
        if (!(expression)) {                                                   \
            std::fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expression); \
            std::abort();                                                      \
        }                                                                      \
    } while (false)

namespace {
constexpr char frame[] =
    "BOARDSESH_QA {\"schemaVersion\":1,\"requestId\":\"qa\",\"commands\":[{\"position\":198,\"r\":252,"
    "\"g\":180,\"b\":0}]}\n";
constexpr char logLine[] = "I NimBLEServer: mtu update event; conn_handle=6 mtu=247\n";

struct RecordingOutput {
    unsigned calls = 0;
    size_t omit = 0;
    std::string received;
    size_t write(const uint8_t* bytes, size_t length) {
        ++calls;
        received.assign(reinterpret_cast<const char*>(bytes), length - omit);
        return length - omit;
    }
};

// HWCDC write acceptance precedes ISR transmission. IDF's secondary console can
// reach the physical FIFO independently after the enqueueing caller has returned.
struct DeferredOutput {
    std::string queued;
    std::string wire;
    size_t write(const uint8_t* bytes, size_t length) {
        queued.assign(reinterpret_cast<const char*>(bytes), length);
        return length;
    }
    void drain(size_t count) {
        wire.append(queued, 0, count);
        queued.erase(0, count);
    }
};
}  // namespace

int main() {
    const char json[] = "{\"schemaVersion\":1,\"commands\":[{\"position\":198,\"r\":252,\"g\":180,\"b\":0}]}";
    const size_t jsonLength = sizeof(json) - 1;
    const size_t frameLength = gym_fixture::qaFrameLength(jsonLength);
    std::string encoded(frameLength + 1, '?');
    unsigned serializerCalls = 0;
    auto overwriteJson = [&](char* destination, size_t capacity) {
        ++serializerCalls;
        CHECK(capacity == sizeof(json));
        // Replacing the isolated JSON span must preserve the prefix, including
        // with ArduinoJson 7's destination-replacement semantics.
        std::memcpy(destination, json, sizeof(json));
        return jsonLength;
    };
    CHECK(gym_fixture::buildQaFrame(encoded.data(), encoded.size(), jsonLength, overwriteJson) == frameLength);
    CHECK(encoded.substr(0, frameLength) == std::string(gym_fixture::QA_LINE_PREFIX) + json + "\n");
    CHECK(encoded[frameLength] == '\0');
    CHECK(!gym_fixture::buildQaFrame(encoded.data(), frameLength, jsonLength, overwriteJson));
    CHECK(!gym_fixture::buildQaFrame(nullptr, encoded.size(), jsonLength, overwriteJson));
    CHECK(gym_fixture::qaFrameLength(gym_fixture::MAX_QA_LINE_BYTES) == 0);
    CHECK(gym_fixture::qaFrameLength(SIZE_MAX) == 0);
    CHECK(serializerCalls == 1);
    CHECK(!gym_fixture::buildQaFrame(encoded.data(), encoded.size(), jsonLength,
                                     [&](char*, size_t) { return jsonLength - 1; }));

    RecordingOutput output;
    std::string maximum(gym_fixture::MAX_QA_LINE_BYTES, 'x');
    maximum.back() = '\n';
    CHECK(gym_fixture::writeQaLine(output, maximum.data(), maximum.size()));
    CHECK(output.calls == 1 && output.received == maximum);
    CHECK(!gym_fixture::writeQaLine(output, nullptr, 1));
    CHECK(!gym_fixture::writeQaLine(output, "", 0));
    CHECK(!gym_fixture::writeQaLine(output, "incomplete", 10));
    maximum.push_back('\n');
    CHECK(!gym_fixture::writeQaLine(output, maximum.data(), maximum.size()));
    CHECK(output.calls == 1);
    output.omit = 1;
    CHECK(!gym_fixture::writeQaLine(output, frame, sizeof(frame) - 1));
    CHECK(output.calls == 2);

    // A full accepted enqueue (inside any caller-held lock) does not make queued
    // bytes immune to another console's later FIFO writes. This is the real
    // deferred behavior missed by the earlier synchronous POSIX-write model.
    DeferredOutput deferred;
    CHECK(gym_fixture::writeQaLine(deferred, frame, sizeof(frame) - 1));
    CHECK(deferred.wire.empty());
    const std::string expectedFrame(frame);
    deferred.drain(54);
    deferred.wire += logLine;
    deferred.drain(deferred.queued.size());
    CHECK(deferred.wire == expectedFrame.substr(0, 54) + logLine + expectedFrame.substr(54));
    CHECK(deferred.wire != expectedFrame);
    // With the competing producer compiled out, that queue drains unchanged.
    // Actual NimBLE producer suppression is checked in the target object.
    DeferredOutput quiet;
    CHECK(gym_fixture::writeQaLine(quiet, frame, sizeof(frame) - 1));
    quiet.drain(quiet.queued.size());
    CHECK(quiet.wire == expectedFrame);
    std::printf("QA output: %u checks passed\n", checks);
}
