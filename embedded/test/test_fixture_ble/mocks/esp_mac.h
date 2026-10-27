#pragma once
#define ESP_OK 0
#define ESP_MAC_BT 0
inline int esp_read_mac(uint8_t* output, int) {
    for (int i = 0; i < 6; i++)
        output[i] = i;
    return 0;
}
