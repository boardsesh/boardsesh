use board_renderer_core::renderer::render_overlay;
use board_renderer_core::types::RenderConfig;
use std::slice;

/// Render a board overlay from a JSON config string.
///
/// Returns 0 on success, -1 on JSON parse error, -2 on render error.
/// On success, `out_data` points to heap-allocated RGBA pixel data,
/// `out_len` is the byte length, and `out_width`/`out_height` are dimensions.
/// The caller must free the data with `board_renderer_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_render(
    config_json: *const u8,
    config_json_len: u32,
    out_data: *mut *mut u8,
    out_len: *mut u32,
    out_width: *mut u32,
    out_height: *mut u32,
) -> i32 {
    if config_json.is_null()
        || out_data.is_null()
        || out_len.is_null()
        || out_width.is_null()
        || out_height.is_null()
    {
        return -1;
    }

    let json_bytes = unsafe { slice::from_raw_parts(config_json, config_json_len as usize) };
    let json_str = match std::str::from_utf8(json_bytes) {
        Ok(s) => s,
        Err(_) => return -1,
    };

    let config: RenderConfig = match serde_json::from_str(json_str) {
        Ok(c) => c,
        Err(_) => return -1,
    };

    match render_overlay(&config) {
        Ok((rgba_data, width, height)) => {
            let mut boxed = rgba_data.into_boxed_slice();
            unsafe {
                *out_data = boxed.as_mut_ptr();
                *out_len = boxed.len() as u32;
                *out_width = width;
                *out_height = height;
            }
            std::mem::forget(boxed);
            0
        }
        Err(_) => -2,
    }
}

/// Free memory previously allocated by `board_renderer_render`.
///
/// # Safety
/// `ptr` must have been returned by `board_renderer_render` and `len`
/// must be the corresponding `out_len`. The allocation came from
/// `into_boxed_slice`, so reconstructing it as a `Box<[u8]>` (not a
/// `Vec`) matches the original allocator metadata and drops correctly
/// regardless of any future change to the allocation path on the
/// render side.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_free(ptr: *mut u8, len: u32) {
    if !ptr.is_null() && len > 0 {
        let slice = unsafe { slice::from_raw_parts_mut(ptr, len as usize) };
        drop(unsafe { Box::from_raw(slice as *mut [u8]) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    /// Minimal valid config — empty holds, deterministic 1x1 output.
    fn minimal_config_json() -> String {
        r#"{
            "board_width": 100,
            "board_height": 100,
            "output_width": 1,
            "frames": "",
            "thumbnail": true,
            "holds": [],
            "hold_state_map": {}
        }"#
        .to_string()
    }

    #[test]
    fn returns_minus_one_on_null_config_ptr() {
        let mut out_data: *mut u8 = ptr::null_mut();
        let mut out_len: u32 = 0;
        let mut out_w: u32 = 0;
        let mut out_h: u32 = 0;
        let result = unsafe {
            board_renderer_render(
                ptr::null(),
                0,
                &mut out_data,
                &mut out_len,
                &mut out_w,
                &mut out_h,
            )
        };
        assert_eq!(result, -1);
        assert!(out_data.is_null());
    }

    #[test]
    fn returns_minus_one_on_null_out_param() {
        let json = minimal_config_json();
        let mut out_len: u32 = 0;
        let mut out_w: u32 = 0;
        let mut out_h: u32 = 0;
        let result = unsafe {
            board_renderer_render(
                json.as_ptr(),
                json.len() as u32,
                ptr::null_mut(),
                &mut out_len,
                &mut out_w,
                &mut out_h,
            )
        };
        assert_eq!(result, -1);
    }

    #[test]
    fn returns_minus_one_on_invalid_json() {
        let bad = b"{ this is not json";
        let mut out_data: *mut u8 = ptr::null_mut();
        let mut out_len: u32 = 0;
        let mut out_w: u32 = 0;
        let mut out_h: u32 = 0;
        let result = unsafe {
            board_renderer_render(
                bad.as_ptr(),
                bad.len() as u32,
                &mut out_data,
                &mut out_len,
                &mut out_w,
                &mut out_h,
            )
        };
        assert_eq!(result, -1);
        assert!(out_data.is_null());
    }

    #[test]
    fn returns_minus_one_on_non_utf8_bytes() {
        // 0xC0 / 0xC1 are never valid in UTF-8.
        let bad: [u8; 4] = [0xC0, 0xC1, 0xFF, 0xFE];
        let mut out_data: *mut u8 = ptr::null_mut();
        let mut out_len: u32 = 0;
        let mut out_w: u32 = 0;
        let mut out_h: u32 = 0;
        let result = unsafe {
            board_renderer_render(
                bad.as_ptr(),
                bad.len() as u32,
                &mut out_data,
                &mut out_len,
                &mut out_w,
                &mut out_h,
            )
        };
        assert_eq!(result, -1);
    }

    #[test]
    fn accepts_config_without_mirrored_field() {
        // Mobile callers omit `mirrored` because they flip with CSS;
        // the field must default to false rather than failing to parse.
        let json = minimal_config_json();
        assert!(
            !json.contains("mirrored"),
            "test fixture should not declare mirrored"
        );

        let mut out_data: *mut u8 = ptr::null_mut();
        let mut out_len: u32 = 0;
        let mut out_w: u32 = 0;
        let mut out_h: u32 = 0;
        let result = unsafe {
            board_renderer_render(
                json.as_ptr(),
                json.len() as u32,
                &mut out_data,
                &mut out_len,
                &mut out_w,
                &mut out_h,
            )
        };
        assert_eq!(result, 0);
        assert!(!out_data.is_null());
        assert_eq!(out_len, 4); // 1x1 pixel, RGBA = 4 bytes
        assert_eq!(out_w, 1);
        assert_eq!(out_h, 1);
        unsafe { board_renderer_free(out_data, out_len) };
    }

    #[test]
    fn free_is_a_noop_on_null_or_zero_len() {
        // Should not panic / abort.
        unsafe { board_renderer_free(ptr::null_mut(), 0) };
        unsafe { board_renderer_free(ptr::null_mut(), 100) };

        let mut byte: u8 = 0;
        unsafe { board_renderer_free(&mut byte as *mut u8, 0) };
    }

    #[test]
    fn render_then_free_roundtrip_does_not_leak_metadata() {
        // Best-effort: call render+free many times; with the wrong allocator
        // pairing this would corrupt the heap on at least one of the runs.
        for _ in 0..50 {
            let json = minimal_config_json();
            let mut out_data: *mut u8 = ptr::null_mut();
            let mut out_len: u32 = 0;
            let mut out_w: u32 = 0;
            let mut out_h: u32 = 0;
            let result = unsafe {
                board_renderer_render(
                    json.as_ptr(),
                    json.len() as u32,
                    &mut out_data,
                    &mut out_len,
                    &mut out_w,
                    &mut out_h,
                )
            };
            assert_eq!(result, 0);
            unsafe { board_renderer_free(out_data, out_len) };
        }
    }
}
