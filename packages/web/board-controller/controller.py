#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Boardsesh contributors

"""
Kilter Board LED Controller - Simplified Version
Assumes LEDs are wired in order matching hold positions
"""

import time
import logging
import board
import busio
from typing import List

# Import NeoPixel SPI library
try:
    from adafruit_neopixel_spi import NeoPixel_SPI
    LED_SUPPORT = True
except ImportError:
    print("Error: adafruit-circuitpython-neopixel-spi not installed.")
    print("Install with: sudo pip3 install adafruit-circuitpython-neopixel-spi")
    exit(1)

# Import our Bluetooth components
from kilter_official_app import (
    Application, KilterAdvertisement, UartService, 
    RxCharacteristic as BaseRxCharacteristic,
    MessageBuffer as BaseMessageBuffer,
    logger, dbus, GLib, BLUEZ_SERVICE_NAME,
    GATT_MANAGER_IFACE, LE_ADVERTISING_MANAGER_IFACE,
    configure_adapter
)

# Configuration - ADJUST THESE FOR YOUR SETUP
LED_COUNT = 300          # Total number of LEDs in your strip
BRIGHTNESS = 0.5         # Global brightness (0.0-1.0)
PIXEL_ORDER = 'GRB'      # Most WS2811/WS2812 use GRB

class SimpleLedController:
    """Simple LED controller - position maps directly to LED index"""
    
    def __init__(self, led_count: int = LED_COUNT):
        self.led_count = led_count
        self.pixels = None
        
        if LED_SUPPORT:
            self._init_pixels()
    
    def _init_pixels(self):
        """Initialize the NeoPixel strip via SPI"""
        try:
            # Set up SPI
            spi = busio.SPI(board.SCK, MOSI=board.MOSI)
            
            # Create NeoPixel object
            self.pixels = NeoPixel_SPI(
                spi,
                self.led_count,
                pixel_order=PIXEL_ORDER,
                auto_write=False,
                brightness=BRIGHTNESS
            )
            
            logger.info(f"✅ NeoPixels initialized: {self.led_count} LEDs")
            
            # Turn off all LEDs
            self.clear()
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize NeoPixels: {e}")
            raise
    
    def clear(self):
        """Turn off all LEDs"""
        if self.pixels:
            self.pixels.fill((0, 0, 0))
            self.pixels.show()
    
    def set_led(self, position: int, r: int, g: int, b: int):
        """Set a single LED - position IS the LED index"""
        if not self.pixels:
            return
            
        if 0 <= position < self.led_count:
            self.pixels[position] = (r, g, b)
        else:
            logger.warning(f"LED position {position} out of range (max: {self.led_count-1})")
    
    def update(self, led_data: List[tuple]):
        """
        Update multiple LEDs at once
        led_data: List of (position, r, g, b) tuples
        """
        if not self.pixels:
            return
        
        # Clear all LEDs first
        self.pixels.fill((0, 0, 0))
        
        # Set the specified LEDs
        for position, r, g, b in led_data:
            if 0 <= position < self.led_count:
                self.pixels[position] = (r, g, b)
        
        # Update the strip
        self.pixels.show()
        logger.info(f"Updated {len(led_data)} LEDs")
    
    def test_pattern(self):
        """Simple test to verify LEDs work"""
        if not self.pixels:
            return
            
        logger.info("Running test pattern...")
        
        # Red sweep
        print("Red sweep...")
        for i in range(min(50, self.led_count)):
            self.pixels.fill((0, 0, 0))
            self.pixels[i] = (255, 0, 0)
            self.pixels.show()
            time.sleep(0.02)
        
        # All green
        print("All green...")
        self.pixels.fill((0, 255, 0))
        self.pixels.show()
        time.sleep(1)
        
        # All blue
        print("All blue...")
        self.pixels.fill((0, 0, 255))
        self.pixels.show()
        time.sleep(1)
        
        # Clear
        self.clear()
        logger.info("Test complete")

class SimpleMessageBuffer(BaseMessageBuffer):
    """Message buffer that controls LEDs based on received commands"""
    
    def __init__(self, led_controller: SimpleLedController):
        super().__init__()
        self.led_controller = led_controller
        self.current_leds = []  # Accumulate LEDs for multi-part messages
    
    def decode_led_data_v2(self, command, data):
        """Decode API v2 LED data"""
        led_count = len(data) // 2
        logger.info(f"API v2: {led_count} LEDs, command: {command}")
        
        led_data = []
        
        for i in range(led_count):
            if i * 2 + 1 >= len(data):
                break
            
            pos_low = data[i * 2]
            color_pos = data[i * 2 + 1]
            
            position = pos_low | ((color_pos & 0x03) << 8)
            r = ((color_pos >> 6) & 0x03) * 85  # Scale 2-bit to 8-bit
            g = ((color_pos >> 4) & 0x03) * 85
            b = ((color_pos >> 2) & 0x03) * 85
            
            led_data.append((position, r, g, b))
        
        self._process_command(command, led_data)
    
    def decode_led_data_v3(self, command, data):
        """Decode API v3 LED data"""
        led_count = len(data) // 3
        logger.info(f"API v3: {led_count} LEDs, command: {command}")
        
        led_data = []
        
        for i in range(led_count):
            if i * 3 + 2 >= len(data):
                break
            
            position = (data[i * 3] << 8) | data[i * 3 + 1]
            color = data[i * 3 + 2]
            
            r = ((color >> 5) & 0x07) * 36  # Scale 3-bit to 8-bit
            g = ((color >> 2) & 0x07) * 36
            b = (color & 0x03) * 85         # Scale 2-bit to 8-bit
            
            led_data.append((position, r, g, b))
        
        self._process_command(command, led_data)
    
    def _process_command(self, command: str, led_data: List[tuple]):
        """Process commands and update LEDs"""
        if command in ['P', 'T']:  # Single packet
            self.led_controller.update(led_data)
        
        elif command in ['N', 'R']:  # Start multi-packet
            self.current_leds = led_data
        
        elif command in ['M', 'Q']:  # Continue multi-packet
            self.current_leds.extend(led_data)
        
        elif command in ['O', 'S']:  # End multi-packet
            self.current_leds.extend(led_data)
            self.led_controller.update(self.current_leds)
            self.current_leds = []

class SimpleRxCharacteristic(BaseRxCharacteristic):
    """RX Characteristic with our simple message buffer"""
    
    def __init__(self, bus, index, service, led_controller):
        super().__init__(bus, index, service)
        self.message_buffer = SimpleMessageBuffer(led_controller)

def main():
    """Run the Kilter Board emulator with LED support"""
    global mainloop
    
    # Initialize LED controller
    led_controller = SimpleLedController()
    
    # Test mode
    if '--test' in __import__('sys').argv:
        led_controller.test_pattern()
        return
    
    # Set up D-Bus
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    
    adapter = '/org/bluez/hci0'
    configure_adapter(bus, adapter)
    
    # Get managers
    service_manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE_NAME, adapter),
        GATT_MANAGER_IFACE)
    
    ad_manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE_NAME, adapter),
        LE_ADVERTISING_MANAGER_IFACE)
    
    # Create application with LED support
    app = Application(bus)
    app.services.clear()
    
    uart_service = UartService(bus, 0)
    uart_service.characteristics[0] = SimpleRxCharacteristic(
        bus, 0, uart_service, led_controller)
    
    app.add_service(uart_service)
    
    # Create advertisement
    adv = KilterAdvertisement(bus, 0)
    
    mainloop = GLib.MainLoop()
    
    # Register callbacks
    def register_app_cb():
        logger.info('✅ GATT application registered')
        logger.info(f'💡 LED controller ready with {led_controller.led_count} LEDs')
    
    def register_app_error_cb(error):
        logger.error('Failed to register application: ' + str(error))
        mainloop.quit()
    
    def register_ad_cb():
        logger.info('✅ Advertisement registered')
        logger.info('📱 Ready for Kilter Board app')
    
    def register_ad_error_cb(error):
        logger.error('Failed to register advertisement: ' + str(error))
    
    # Register everything
    logger.info('Starting Kilter Board LED Controller...')
    
    service_manager.RegisterApplication(app.get_path(), {},
                                      reply_handler=register_app_cb,
                                      error_handler=register_app_error_cb)
    
    ad_manager.RegisterAdvertisement(adv.get_path(), {},
                                   reply_handler=register_ad_cb,
                                   error_handler=register_ad_error_cb)
    
    logger.info('Press Ctrl+C to stop')
    
    try:
        mainloop.run()
    except KeyboardInterrupt:
        logger.info('\nShutting down...')
        led_controller.clear()
        mainloop.quit()

if __name__ == '__main__':
    main()
