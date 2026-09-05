// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/*----------------------------------------------------------------------------/
  Bus_RGB_Bounce - LovyanGFX RGB bus with bounce buffers in internal SRAM.

  Replaces LovyanGFX's Bus_RGB which does direct PSRAM→DMA (causing "bouncing
  column" artifacts). This class keeps the framebuffer in PSRAM for CPU drawing
  but uses two small SRAM bounce buffers for DMA output to the LCD panel.

  Data flow:
    PSRAM framebuffer  →  ISR copies chunks  →  SRAM bounce buf  →  DMA → LCD
    CPU writes here                              DMA reads here (no contention)

  Two separate ISRs handle the pipeline:
  1. LCD_CAM VSYNC ISR: resets position, fills initial buffers, restarts DMA
  2. GDMA TX EOF ISR: refills the just-consumed bounce buffer with next chunk

  Works with ESP-IDF 4.4 (no esp_lcd bounce buffer API needed).
  Uses the same low-level LCD_CAM + GDMA registers as LovyanGFX's Bus_RGB.
/----------------------------------------------------------------------------*/
#pragma once

#if __has_include(<esp_lcd_panel_rgb.h>)

#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_rgb.h>
#include <esp_private/gdma.h>
#include <hal/dma_types.h>

#include <lgfx/v1/Bus.hpp>
#include <lgfx/v1/panel/Panel_FrameBufferBase.hpp>
#include <lgfx/v1/platforms/common.hpp>

struct lcd_cam_dev_t;

namespace lgfx
{
  inline namespace v1
  {

    class Bus_RGB_Bounce : public IBus
    {
    public:
      // Same config_t as Bus_RGB for drop-in compatibility
      struct config_t
      {
        Panel_FrameBufferBase *panel = nullptr;

        int8_t port = 0;

        uint32_t freq_write = 16000000;

        int8_t pin_pclk = -1;
        int8_t pin_vsync = -1;
        int8_t pin_hsync = -1;
        int8_t pin_henable = -1;
        union
        {
          int8_t pin_data[16];
          struct
          {
            int8_t pin_d0;
            int8_t pin_d1;
            int8_t pin_d2;
            int8_t pin_d3;
            int8_t pin_d4;
            int8_t pin_d5;
            int8_t pin_d6;
            int8_t pin_d7;
            int8_t pin_d8;
            int8_t pin_d9;
            int8_t pin_d10;
            int8_t pin_d11;
            int8_t pin_d12;
            int8_t pin_d13;
            int8_t pin_d14;
            int8_t pin_d15;
          };
        };

        int8_t hsync_pulse_width = 0;
        int8_t hsync_back_porch = 0;
        int8_t hsync_front_porch = 0;
        int8_t vsync_pulse_width = 0;
        int8_t vsync_back_porch = 0;
        int8_t vsync_front_porch = 0;
        bool hsync_polarity = 0;
        bool vsync_polarity = 0;
        bool pclk_active_neg = 1;
        bool de_idle_high = 0;
        bool pclk_idle_high = 0;
      };

      const config_t &config(void) const { return _cfg; }
      void config(const config_t &config);

      bus_type_t busType(void) const override { return bus_type_t::bus_unknown; }

      bool init(void) override;
      void release(void) override;

      void beginTransaction(void) override {}
      void endTransaction(void) override {}
      void wait(void) override {}
      bool busy(void) const override { return false; }

      void flush(void) override {}
      bool writeCommand(uint32_t data, uint_fast8_t bit_length) override { return true; }
      void writeData(uint32_t data, uint_fast8_t bit_length) override {}
      void writeDataRepeat(uint32_t data, uint_fast8_t bit_length, uint32_t count) override {}
      void writePixels(pixelcopy_t *param, uint32_t length) override {}
      void writeBytes(const uint8_t *data, uint32_t length, bool dc, bool use_dma) override {}

      void initDMA(void) override {}
      void addDMAQueue(const uint8_t *data, uint32_t length) override {}
      void execDMAQueue(void) override {}
      uint8_t *getDMABuffer(uint32_t length) override;

      void beginRead(void) override {}
      void endRead(void) override {}
      uint32_t readData(uint_fast8_t bit_length) override { return 0; }
      bool readBytes(uint8_t *dst, uint32_t length, bool use_dma) override { return false; }
      void readPixels(void *dst, pixelcopy_t *param, uint32_t length) override {}

    private:
      config_t _cfg;

      // Framebuffer in PSRAM (CPU draws here)
      uint8_t *_frame_buffer = nullptr;
      size_t _fb_size = 0;

      // Two bounce buffers in internal SRAM (DMA reads from here)
      // Each holds BOUNCE_LINES scanlines worth of pixel data
      static constexpr int BOUNCE_LINES = 10;
      uint8_t *_bounce_buf[2] = {nullptr, nullptr};
      size_t _bounce_buf_size = 0; // bytes per bounce buffer

      // DMA descriptors for bounce buffers (in DMA-capable SRAM)
      // Each bounce buffer may need multiple descriptors (max 4092 bytes each)
      dma_descriptor_t *_bounce_dma_desc[2] = {nullptr, nullptr};
      int _desc_per_bounce = 0;

      // Tracking which chunk of the framebuffer to copy next
      volatile size_t _bounce_pos = 0;       // byte offset into framebuffer for next copy
      volatile int _next_refill_buf = 0;     // which bounce buffer to refill next (0 or 1)

      // DMA config and handles
      uint32_t _conf0_val = 0;  // Saved GDMA conf0 value for ISR reset
      int32_t _dma_ch = -1;
      gdma_channel_handle_t _gdma_chan = nullptr;  // GDMA channel (owned, for cleanup)
      intr_handle_t _lcd_intr_handle = nullptr;    // LCD_CAM VSYNC interrupt

      // LCD_CAM ISR: handles VSYNC (frame start) - resets and restarts DMA
      static void IRAM_ATTR vsync_isr_handler(void *args);

      // GDMA EOF callback: refills consumed bounce buffer (called from GDMA driver ISR)
      static bool IRAM_ATTR gdma_eof_callback(gdma_channel_handle_t dma_chan, gdma_event_data_t *event_data, void *user_data);

      // Fill a bounce buffer with the next chunk from the PSRAM framebuffer
      void IRAM_ATTR fillBounceBuffer(int buf_idx);
    };

  }
}

#endif
