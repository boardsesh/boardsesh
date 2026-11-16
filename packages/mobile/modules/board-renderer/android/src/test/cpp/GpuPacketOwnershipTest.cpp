#include "../../main/cpp/gpu_packet_ownership.h"
#include <cassert>

int main() {
    AuraGpuBytes resident_hit_pixels{};
    AuraGpuBytes resident_hit_handles{};
    AuraGpuBytes cancelled_header{};
    void *empty = aura_gpu_direct_buffer_address(resident_hit_pixels);
    assert(empty != nullptr);
    assert(aura_gpu_direct_buffer_address(resident_hit_handles) == empty);
    assert(aura_gpu_direct_buffer_address(cancelled_header) == empty);
    assert(resident_hit_pixels.pointer == nullptr && resident_hit_pixels.length == 0);
    uint8_t payload[4] = {1,2,3,4};
    AuraGpuBytes owned{payload,4};
    assert(aura_gpu_direct_buffer_address(owned) == payload);
    assert(owned.pointer == payload && owned.length == 4);
}
