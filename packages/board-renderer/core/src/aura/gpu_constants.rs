//! Aura's shared GPU budget and motion values. Native aliases preserve them.
//! Timings use integer milliseconds so iOS seconds and Android nanoseconds
//! derive from the same values without changing either platform's easing.

pub const MAX_GPU_BYTES: usize = 128 * 1024 * 1024;

pub const EDIT_DURATION_MS: u32 = 350;
pub const EDIT_PEAK_TIME_MS: u32 = 100;
pub const EDIT_PEAK_REACH: f32 = 1.35;
pub const REVEAL_BAND: f32 = 0.22;

/// How the player's swipe hands the wall from one climb to the next, written
/// to uniform `motion.z`. The wipe sweeps a soft band across the wall with the
/// page position. The swap is position-independent: holds only in the climb
/// being left take one weight, holds only in the arriving climb another, and
/// holds lit the same way in both a third. Its timing lives in the app.
pub const REVEAL_MODE_WIPE: u32 = 0;
pub const REVEAL_MODE_SWAP: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_values_preserve_existing_native_timing_and_float_bits() {
        assert_eq!(MAX_GPU_BYTES, 134_217_728);
        assert_eq!(u64::from(EDIT_DURATION_MS) * 1_000_000, 350_000_000);
        assert_eq!(u64::from(EDIT_PEAK_TIME_MS) * 1_000_000, 100_000_000);
        assert_eq!(
            (f64::from(EDIT_DURATION_MS) / 1000.0).to_bits(),
            0.350_f64.to_bits()
        );
        assert_eq!(
            (f64::from(EDIT_PEAK_TIME_MS) / 1000.0).to_bits(),
            0.100_f64.to_bits()
        );
        assert_eq!(EDIT_PEAK_REACH.to_bits(), 0x3fac_cccd);
        assert_eq!(REVEAL_BAND.to_bits(), 0x3e61_47ae);
        assert_eq!((REVEAL_MODE_WIPE, REVEAL_MODE_SWAP), (0, 1));
    }
}
