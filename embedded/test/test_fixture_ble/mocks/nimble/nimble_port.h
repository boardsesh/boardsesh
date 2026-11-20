#pragma once

#include <functional>
#include <vector>

struct ble_npl_event {
    void (*callback)(ble_npl_event*) = nullptr;
    void* argument = nullptr;
};
struct ble_npl_eventq {
    std::vector<ble_npl_event*> pending;
};
namespace fixture_ble_host {
inline ble_npl_eventq eventQueue;
inline bool runEventsOnWait = true;
inline std::function<void()> beforeEvent;
inline void runEvents() {
    while (!eventQueue.pending.empty()) {
        ble_npl_event* event = eventQueue.pending.front();
        eventQueue.pending.erase(eventQueue.pending.begin());
        if (beforeEvent) {
            auto callback = std::move(beforeEvent);
            beforeEvent = nullptr;
            callback();
        }
        event->callback(event);
    }
}
}  // namespace fixture_ble_host
inline ble_npl_eventq* nimble_port_get_dflt_eventq() {
    return &fixture_ble_host::eventQueue;
}
inline void ble_npl_event_init(ble_npl_event* event, void (*callback)(ble_npl_event*), void* argument) {
    event->callback = callback;
    event->argument = argument;
}
inline void* ble_npl_event_get_arg(ble_npl_event* event) {
    return event->argument;
}
inline void ble_npl_eventq_put(ble_npl_eventq* queue, ble_npl_event* event) {
    queue->pending.push_back(event);
}
