// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/*----------------------------------------------------------------------------/
  Bus_RGB_Bounce - LovyanGFX RGB bus with bounce buffers in internal SRAM.

  Two ISRs drive the bounce buffer pipeline:
  1. LCD_CAM VSYNC ISR (60Hz): resets to frame start, fills both buffers,
     restarts DMA from bounce[0].
  2. GDMA TX EOF ISR (~2880Hz for 480 lines / 10 lines per bounce * 60fps):
     fires each time DMA finishes one bounce buffer. Refills it with the next
     chunk from the PSRAM framebuffer while DMA reads the other buffer.

  Based on LovyanGFX Bus_RGB with identical LCD_CAM + GDMA register setup.
/----------------------------------------------------------------------------*/
#if defined(ESP_PLATFORM)
#include <sdkconfig.h>
#if defined(CONFIG_IDF_TARGET_ESP32S3)
#if __has_include(<esp_lcd_panel_rgb.h>)

#include "bus_rgb_bounce.h"

#include <esp_lcd_panel_rgb.h>
#include <esp_lcd_panel_io.h>
#include <esp_pm.h>
#include <esp_log.h>
#include <esp_rom_gpio.h>
#include <rom/gpio.h>
#include <hal/gdma_ll.h>
#include <hal/gpio_ll.h>
#include <hal/gpio_hal.h>
#include <hal/lcd_ll.h>
#include <hal/lcd_hal.h>
#include <soc/lcd_periph.h>
#include <soc/lcd_cam_reg.h>
#include <soc/lcd_cam_struct.h>
#include <soc/gdma_channel.h>
#include <soc/gdma_reg.h>
#include <soc/gdma_struct.h>
#include <soc/periph_defs.h>

#if __has_include(<esp_private/periph_ctrl.h>)
#include <esp_private/periph_ctrl.h>
#else
#include <driver/periph_ctrl.h>
#endif

#if defined(ESP_IDF_VERSION_VAL)
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
#define LGFX_HAL_FUNC_SEL
#endif
#endif

#include <string.h>

static const char *TAG = "Bus_RGB_Bounce";

namespace lgfx
{
  inline namespace v1
  {

    static __attribute__((always_inline)) inline volatile uint32_t *reg(uint32_t addr)
    {
      return (volatile uint32_t *)ETS_UNCACHED_ADDR(addr);
    }

    static lcd_cam_dev_t *getDev(int port)
    {
      return &LCD_CAM;
    }

    static void _gpio_pin_sig(uint32_t pin, uint32_t sig)
    {
#if defined(LGFX_HAL_FUNC_SEL)
      gpio_hal_context_t gpio_hal = {
          .dev = GPIO_HAL_GET_HW(GPIO_PORT_0)};
      gpio_hal_func_sel(&gpio_hal, pin, PIN_FUNC_GPIO);
#else
      gpio_hal_iomux_func_sel(GPIO_PIN_MUX_REG[pin], PIN_FUNC_GPIO);
#endif
      gpio_set_direction((gpio_num_t)pin, GPIO_MODE_OUTPUT);
      esp_rom_gpio_connect_out_signal(pin, sig, false, false);
    }

    // Build a DMA descriptor chain for a bounce buffer.
    // Each descriptor holds up to MAX_DMA_LEN bytes.
    // The last descriptor has suc_eof=1 to trigger the GDMA EOF interrupt.
    // Returns number of descriptors used.
    static int buildDescriptorChain(dma_descriptor_t *desc, uint8_t *buf, size_t len)
    {
      static constexpr size_t MAX_DMA_LEN = (4096 - 64);
      int count = 0;
      size_t remaining = len;
      uint8_t *ptr = buf;

      while (remaining > MAX_DMA_LEN)
      {
        // owner=1, suc_eof=0: DMA owns this descriptor, not end of frame
        desc[count].dw0.size = MAX_DMA_LEN;
        desc[count].dw0.length = MAX_DMA_LEN;
        desc[count].dw0.suc_eof = 0;
        desc[count].dw0.owner = 1;
        desc[count].buffer = ptr;
        desc[count].next = &desc[count + 1];
        ptr += MAX_DMA_LEN;
        remaining -= MAX_DMA_LEN;
        count++;
      }

      // Last descriptor: owner=1, suc_eof=1 (triggers GDMA EOF interrupt)
      size_t aligned_size = (remaining + 3) & (~3);
      desc[count].dw0.size = aligned_size;
      desc[count].dw0.length = remaining;
      desc[count].dw0.suc_eof = 1;
      desc[count].dw0.owner = 1;
      desc[count].buffer = ptr;
      desc[count].next = nullptr; // will be chained later
      count++;

      return count;
    }

    void Bus_RGB_Bounce::config(const config_t &cfg)
    {
      _cfg = cfg;
    }

    IRAM_ATTR void Bus_RGB_Bounce::fillBounceBuffer(int buf_idx)
    {
      size_t remaining = (_bounce_pos < _fb_size) ? (_fb_size - _bounce_pos) : 0;
      size_t copy_size = (remaining < _bounce_buf_size) ? remaining : _bounce_buf_size;

      if (copy_size > 0)
      {
        memcpy(_bounce_buf[buf_idx], _frame_buffer + _bounce_pos, copy_size);
      }

      // Zero-pad if we're at the end of the framebuffer
      if (copy_size < _bounce_buf_size)
      {
        memset(_bounce_buf[buf_idx] + copy_size, 0, _bounce_buf_size - copy_size);
      }

      _bounce_pos += _bounce_buf_size;
    }

    // LCD_CAM VSYNC ISR: fires once per frame (60Hz).
    // Resets the framebuffer read position, pre-fills both bounce buffers,
    // and restarts DMA from the beginning of the descriptor chain.
    IRAM_ATTR void Bus_RGB_Bounce::vsync_isr_handler(void *args)
    {
      Bus_RGB_Bounce *me = (Bus_RGB_Bounce *)args;
      auto dev = getDev(me->_cfg.port);

      uint32_t intr_status = dev->lc_dma_int_st.val & 0x03;
      dev->lc_dma_int_clr.val = intr_status;

      if (intr_status & LCD_LL_EVENT_VSYNC_END)
      {
        // Clear any pending GDMA EOF events from the previous frame
        GDMA.channel[me->_dma_ch].out.int_clr.out_eof = 1;

        // Reset DMA channel FSM and FIFO (also stops DMA)
        // Use saved conf0 value to avoid read-modify-write clearing our settings
        GDMA.channel[me->_dma_ch].out.conf0.val = me->_conf0_val | 4; // bit 2 = out_rst
        GDMA.channel[me->_dma_ch].out.conf0.val = me->_conf0_val;     // clear out_rst

        // Reset to frame start
        me->_bounce_pos = 0;
        me->_next_refill_buf = 0;

        // Pre-fill both bounce buffers with the first two chunks
        me->fillBounceBuffer(0);
        me->fillBounceBuffer(1);

        // After filling both, the next buffer to refill will be 0
        me->_next_refill_buf = 0;

        // Restart DMA - write entire link register atomically to avoid
        // read-modify-write issues (stop bit must be 0 when start is 1)
        typeof(GDMA.channel[0].out.link) link_val;
        link_val.val = 0;
        link_val.addr = (uintptr_t)&me->_bounce_dma_desc[0][0];
        link_val.start = 1;
        GDMA.channel[me->_dma_ch].out.link.val = link_val.val;
      }
    }

    // GDMA TX EOF callback: called by the GDMA driver's ISR each time DMA
    // finishes consuming one bounce buffer (~48 times/frame, ~2880Hz at 60fps).
    // DMA has moved on to the other buffer, so we can safely refill this one.
    IRAM_ATTR bool Bus_RGB_Bounce::gdma_eof_callback(gdma_channel_handle_t dma_chan, gdma_event_data_t *event_data, void *user_data)
    {
      Bus_RGB_Bounce *me = (Bus_RGB_Bounce *)user_data;

      // Refill the buffer that just finished being sent by DMA.
      // DMA is now reading from the OTHER buffer, so this one is safe to write.
      int buf_to_refill = me->_next_refill_buf;
      me->_next_refill_buf = 1 - me->_next_refill_buf;

      // Only refill if there's more framebuffer data to send
      if (me->_bounce_pos < me->_fb_size)
      {
        me->fillBounceBuffer(buf_to_refill);
      }

      return false; // No higher-priority task woken
    }

    bool Bus_RGB_Bounce::init(void)
    {
      uint8_t pixel_bytes = (_cfg.panel->getWriteDepth() & bit_mask) >> 3;
      uint16_t width = _cfg.panel->width();
      uint16_t height = _cfg.panel->height();

      // Calculate sizes
      _fb_size = (size_t)width * pixel_bytes * height;
      _bounce_buf_size = (size_t)width * pixel_bytes * BOUNCE_LINES;

      ESP_LOGI(TAG, "Init: %dx%d, %dbpp, fb=%u bytes, bounce=%u bytes (%d lines)",
               width, height, pixel_bytes * 8, _fb_size, _bounce_buf_size, BOUNCE_LINES);

      // Allocate framebuffer in PSRAM (CPU draws here via LovyanGFX)
      _frame_buffer = (uint8_t *)heap_alloc_psram(_fb_size);
      if (!_frame_buffer)
      {
        ESP_LOGE(TAG, "Failed to allocate framebuffer in PSRAM (%u bytes)", _fb_size);
        return false;
      }
      memset(_frame_buffer, 0, _fb_size);

      // Allocate two bounce buffers in internal DMA-capable SRAM
      for (int i = 0; i < 2; i++)
      {
        _bounce_buf[i] = (uint8_t *)heap_caps_malloc(_bounce_buf_size, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (!_bounce_buf[i])
        {
          ESP_LOGE(TAG, "Failed to allocate bounce buffer %d in SRAM (%u bytes)", i, _bounce_buf_size);
          release();
          return false;
        }
        memset(_bounce_buf[i], 0, _bounce_buf_size);
      }

      ESP_LOGI(TAG, "Allocated %u bytes internal SRAM for bounce buffers", _bounce_buf_size * 2);

      // Allocate DMA descriptors for each bounce buffer
      static constexpr size_t MAX_DMA_LEN = (4096 - 64);
      _desc_per_bounce = (_bounce_buf_size - 1) / MAX_DMA_LEN + 1;
      for (int i = 0; i < 2; i++)
      {
        _bounce_dma_desc[i] = (dma_descriptor_t *)heap_caps_malloc(
            sizeof(dma_descriptor_t) * _desc_per_bounce, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (!_bounce_dma_desc[i])
        {
          ESP_LOGE(TAG, "Failed to allocate DMA descriptors for bounce %d", i);
          release();
          return false;
        }
        buildDescriptorChain(_bounce_dma_desc[i], _bounce_buf[i], _bounce_buf_size);
      }

      // Chain bounce buffer descriptors: 0→1→0→1... (circular ping-pong)
      // Each chain's last descriptor (with suc_eof=1) points to the start of the other.
      // DMA processes bounce[0], fires EOF, continues to bounce[1], fires EOF, loops back.
      _bounce_dma_desc[0][_desc_per_bounce - 1].next = &_bounce_dma_desc[1][0];
      _bounce_dma_desc[1][_desc_per_bounce - 1].next = &_bounce_dma_desc[0][0];

      // --- Initialize LCD_CAM peripheral + GDMA channel ---
      // We allocate the GDMA channel directly (instead of via esp_lcd_new_i80_bus)
      // to get proper ownership of the channel's interrupt for our EOF callback.

      periph_module_enable(PERIPH_LCD_CAM_MODULE);
      periph_module_reset(PERIPH_LCD_CAM_MODULE);

      gdma_channel_alloc_config_t dma_alloc = {};
      dma_alloc.direction = GDMA_CHANNEL_DIRECTION_TX;

      esp_err_t err = gdma_new_channel(&dma_alloc, &_gdma_chan);
      if (err != ESP_OK)
      {
        ESP_LOGE(TAG, "Failed to allocate GDMA channel: %s", esp_err_to_name(err));
        release();
        return false;
      }

      err = gdma_connect(_gdma_chan, GDMA_MAKE_TRIGGER(GDMA_TRIG_PERIPH_LCD, 0));
      if (err != ESP_OK)
      {
        ESP_LOGE(TAG, "Failed to connect GDMA to LCD: %s", esp_err_to_name(err));
        release();
        return false;
      }

      auto dev = getDev(_cfg.port);

      // Configure GPIO pin signals for RGB mode
      {
        static constexpr const uint8_t rgb565sig_tbl[] = {8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7};
        static constexpr const uint8_t rgb332sig_tbl[] = {1, 0, 1, 0, 1, 2, 3, 4, 2, 3, 4, 5, 6, 5, 6, 7};
        auto tbl = (pixel_bytes == 2) ? rgb565sig_tbl : rgb332sig_tbl;
#if SOC_LCDCAM_RGB_LCD_SUPPORTED
        auto sigs = &lcd_periph_rgb_signals.panels[_cfg.port];
#else
        auto sigs = &lcd_periph_signals.panels[_cfg.port];
#endif
        for (size_t i = 0; i < 16; i++)
        {
          _gpio_pin_sig(_cfg.pin_data[i], sigs->data_sigs[tbl[i]]);
        }
        _gpio_pin_sig(_cfg.pin_henable, sigs->de_sig);
        _gpio_pin_sig(_cfg.pin_hsync, sigs->hsync_sig);
        _gpio_pin_sig(_cfg.pin_vsync, sigs->vsync_sig);
        _gpio_pin_sig(_cfg.pin_pclk, sigs->pclk_sig);
      }

      // Find the GDMA channel number for register-level access
      // (gdma_connect already set peri_sel, so we scan for it)
      _dma_ch = search_dma_out_ch(SOC_GDMA_TRIG_PERIPH_LCD0);
      if (_dma_ch < 0)
      {
        ESP_LOGE(TAG, "DMA channel not found after gdma_connect");
        release();
        return false;
      }

      ESP_LOGI(TAG, "Using GDMA TX channel %d", _dma_ch);

      // Configure DMA for internal SRAM burst (not PSRAM)
      typeof(GDMA.channel[0].out.conf0) conf0;
      conf0.val = 0;
      conf0.out_eof_mode = 1;       // EOF when last data is popped from FIFO
      conf0.outdscr_burst_en = 1;   // Enable burst for descriptor reads
      conf0.out_data_burst_en = 1;  // Enable burst for data reads
      GDMA.channel[_dma_ch].out.conf0.val = conf0.val;
      _conf0_val = conf0.val; // Save for VSYNC ISR DMA reset

      typeof(GDMA.channel[0].out.conf1) conf1;
      conf1.val = 0;
      // No external memory burst needed - bounce buffers are in internal SRAM
      conf1.out_ext_mem_bk_size = 0;
      GDMA.channel[_dma_ch].out.conf1.val = conf1.val;

      // --- Configure LCD timing registers (identical to Bus_RGB) ---
      // NOTE: Must be done BEFORE starting DMA or LCD.

      uint32_t hsw = _cfg.hsync_pulse_width;
      uint32_t hbp = _cfg.hsync_back_porch;
      uint32_t active_width = width;
      uint32_t hfp = _cfg.hsync_front_porch;

      uint32_t vsw = _cfg.vsync_pulse_width;
      uint32_t vbp = _cfg.vsync_back_porch;
      uint32_t vfp = _cfg.vsync_front_porch;
      uint32_t active_height = height;

      uint32_t div_a, div_b, div_n, clkcnt;
      calcClockDiv(&div_a, &div_b, &div_n, &clkcnt, 240 * 1000 * 1000, std::min<uint32_t>(_cfg.freq_write, 40000000u));

      typeof(dev->lcd_clock) lcd_clock;
      lcd_clock.lcd_clkcnt_n = std::max<uint32_t>(1u, clkcnt - 1);
      lcd_clock.lcd_clk_equ_sysclk = (clkcnt == 1);
      lcd_clock.lcd_ck_idle_edge = false;
      lcd_clock.lcd_ck_out_edge = _cfg.pclk_idle_high;
      lcd_clock.lcd_clkm_div_num = div_n;
      lcd_clock.lcd_clkm_div_b = div_b;
      lcd_clock.lcd_clkm_div_a = div_a;
      lcd_clock.lcd_clk_sel = 2; // 2=240MHz PLL
      lcd_clock.clk_en = true;
      dev->lcd_clock.val = lcd_clock.val;

      typeof(dev->lcd_user) lcd_user;
      lcd_user.val = 0;
      lcd_user.lcd_always_out_en = true;
      lcd_user.lcd_2byte_en = pixel_bytes > 1;
      lcd_user.lcd_dout = 1;
      lcd_user.lcd_update = 1;
      lcd_user.lcd_reset = 1; // self-clearing
      lcd_user.lcd_dummy_cyclelen = 3;
      dev->lcd_user.val = lcd_user.val;

      typeof(dev->lcd_misc) lcd_misc;
      lcd_misc.val = 0;
      lcd_misc.lcd_afifo_reset = true;
      lcd_misc.lcd_next_frame_en = true;
      lcd_misc.lcd_bk_en = true;
      dev->lcd_misc.val = lcd_misc.val;

      typeof(dev->lcd_ctrl) lcd_ctrl;
      lcd_ctrl.lcd_hb_front = hbp + hsw - 1;
      lcd_ctrl.lcd_va_height = active_height - 1;
      lcd_ctrl.lcd_vt_height = vsw + vbp + active_height + vfp - 1;
      lcd_ctrl.lcd_rgb_mode_en = true;
      dev->lcd_ctrl.val = lcd_ctrl.val;

      typeof(dev->lcd_ctrl1) lcd_ctrl1;
      lcd_ctrl1.lcd_vb_front = vbp + vsw - 1;
      lcd_ctrl1.lcd_ha_width = active_width - 1;
      lcd_ctrl1.lcd_ht_width = hsw + hbp + active_width + hfp - 1;
      dev->lcd_ctrl1.val = lcd_ctrl1.val;

      typeof(dev->lcd_ctrl2) lcd_ctrl2;
      lcd_ctrl2.val = 0;
      lcd_ctrl2.lcd_vsync_width = vsw - 1;
      lcd_ctrl2.lcd_vsync_idle_pol = _cfg.vsync_polarity;
      lcd_ctrl2.lcd_hs_blank_en = true;
      lcd_ctrl2.lcd_hsync_width = hsw - 1;
      lcd_ctrl2.lcd_hsync_idle_pol = _cfg.hsync_polarity;
      lcd_ctrl2.lcd_de_idle_pol = _cfg.de_idle_high;
      dev->lcd_ctrl2.val = lcd_ctrl2.val;

      // --- Register ISR #1: LCD_CAM VSYNC interrupt ---
      // This fires once per frame (60Hz) to reset the bounce buffer pipeline.
      dev->lc_dma_int_ena.val = 1; // Enable VSYNC_END interrupt

      int isr_flags = ESP_INTR_FLAG_INTRDISABLED | ESP_INTR_FLAG_SHARED;
#if SOC_LCDCAM_RGB_LCD_SUPPORTED
      auto lcd_sigs = &lcd_periph_rgb_signals.panels[_cfg.port];
#else
      auto lcd_sigs = &lcd_periph_signals.panels[_cfg.port];
#endif
      esp_intr_alloc_intrstatus(lcd_sigs->irq_id, isr_flags,
                                (uint32_t)&dev->lc_dma_int_st,
                                LCD_LL_EVENT_VSYNC_END,
                                vsync_isr_handler, this, &_lcd_intr_handle);
      esp_intr_enable(_lcd_intr_handle);

      // --- Register GDMA TX EOF callback ---
      // The GDMA driver manages the interrupt internally; our callback is invoked
      // each time DMA finishes consuming one bounce buffer (~2880Hz at 60fps).
      gdma_tx_event_callbacks_t tx_cbs = {};
      tx_cbs.on_trans_eof = gdma_eof_callback;
      err = gdma_register_tx_event_callbacks(_gdma_chan, &tx_cbs, this);
      if (err != ESP_OK)
      {
        ESP_LOGE(TAG, "Failed to register GDMA EOF callback: %s", esp_err_to_name(err));
        release();
        return false;
      }

      // Pre-fill bounce buffers and start DMA
      // Done last, after all config, ISRs, and callbacks are registered.
      _bounce_pos = 0;
      _next_refill_buf = 0;
      fillBounceBuffer(0);
      fillBounceBuffer(1);
      _next_refill_buf = 0;

      // Write entire link register atomically (avoid RMW issues with stop/start bits)
      typeof(GDMA.channel[0].out.link) link_val;
      link_val.val = 0;
      link_val.addr = (uintptr_t)&_bounce_dma_desc[0][0];
      link_val.start = 1;
      GDMA.channel[_dma_ch].out.link.val = link_val.val;

      // Start the LCD
      dev->lcd_user.lcd_update = 1;
      dev->lcd_user.lcd_start = 1;

      ESP_LOGI(TAG, "Started with bounce buffers (%d lines x 2 = %u bytes SRAM, ISRs on LCD_CAM + GDMA ch%d)",
               BOUNCE_LINES, _bounce_buf_size * 2, _dma_ch);

      return true;
    }

    uint8_t *Bus_RGB_Bounce::getDMABuffer(uint32_t length)
    {
      return _frame_buffer;
    }

    void Bus_RGB_Bounce::release(void)
    {
      // Stop LCD and DMA before freeing resources
      if (_dma_ch >= 0)
      {
        auto dev = getDev(_cfg.port);
        dev->lcd_user.lcd_start = 0;
        GDMA.channel[_dma_ch].out.link.stop = 1;
      }

      if (_lcd_intr_handle)
      {
        esp_intr_free(_lcd_intr_handle);
        _lcd_intr_handle = nullptr;
      }

      if (_gdma_chan)
      {
        gdma_disconnect(_gdma_chan);
        gdma_del_channel(_gdma_chan);
        _gdma_chan = nullptr;
        _dma_ch = -1;
        periph_module_disable(PERIPH_LCD_CAM_MODULE);
      }

      for (int i = 0; i < 2; i++)
      {
        if (_bounce_dma_desc[i])
        {
          heap_caps_free(_bounce_dma_desc[i]);
          _bounce_dma_desc[i] = nullptr;
        }
        if (_bounce_buf[i])
        {
          heap_caps_free(_bounce_buf[i]);
          _bounce_buf[i] = nullptr;
        }
      }
      if (_frame_buffer)
      {
        heap_caps_free(_frame_buffer);
        _frame_buffer = nullptr;
      }
    }

  }
}

#endif
#endif
#endif
