#pragma once
#include <nimble/nimble_port.h>

#include <mutex>

struct FixtureBleSemaphore {
    std::mutex mutex;
    bool binary = false;
    bool given = false;
};
using SemaphoreHandle_t = FixtureBleSemaphore*;
inline FixtureBleSemaphore fixtureBleStateMutex;
inline FixtureBleSemaphore fixtureBleCompletionSemaphore;
inline SemaphoreHandle_t xSemaphoreCreateMutex() {
    return &fixtureBleStateMutex;
}
inline SemaphoreHandle_t xSemaphoreCreateBinary() {
    fixtureBleCompletionSemaphore.binary = true;
    fixtureBleCompletionSemaphore.given = false;
    return &fixtureBleCompletionSemaphore;
}
inline bool xSemaphoreTake(SemaphoreHandle_t semaphore, unsigned timeout) {
    if (semaphore->binary) {
        if (!semaphore->given && timeout && fixture_ble_host::runEventsOnWait)
            fixture_ble_host::runEvents();
        const bool available = semaphore->given;
        semaphore->given = false;
        return available;
    }
    semaphore->mutex.lock();
    return true;
}
inline bool xSemaphoreGive(SemaphoreHandle_t semaphore) {
    if (semaphore->binary) {
        semaphore->given = true;
        return true;
    }
    semaphore->mutex.unlock();
    return true;
}
