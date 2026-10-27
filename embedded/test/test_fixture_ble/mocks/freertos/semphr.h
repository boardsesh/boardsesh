#pragma once
#include <mutex>

using SemaphoreHandle_t = std::mutex*;
inline std::mutex fixtureBleStateMutex;
inline SemaphoreHandle_t xSemaphoreCreateMutex() {
    return &fixtureBleStateMutex;
}
inline bool xSemaphoreTake(SemaphoreHandle_t mutex, int) {
    mutex->lock();
    return true;
}
inline bool xSemaphoreGive(SemaphoreHandle_t mutex) {
    mutex->unlock();
    return true;
}
