use board_renderer_core::renderer::render_overlay;
use board_renderer_core::types::RenderConfig;
use std::collections::HashMap;
use std::slice;
use std::sync::{LazyLock, Mutex};

pub mod gpu_packet;

// Keep the original capacity so transferring a Vec never calls shrink_to_fit
// or moves a payload-sized allocation. Legacy PNG buffers remain boxed slices.
static OWNED_GPU_ALLOCATIONS: LazyLock<Mutex<HashMap<usize, (usize, usize)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn transfer_gpu_allocation(mut bytes: Vec<u8>) -> (*mut u8, u32) {
    let pointer = bytes.as_mut_ptr();
    let length = bytes.len();
    let capacity = bytes.capacity();
    let output_length = u32::try_from(length).expect("GPU allocations have bounded lengths");
    OWNED_GPU_ALLOCATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(pointer as usize, (length, capacity));
    std::mem::forget(bytes);
    (pointer, output_length)
}

/// Stable exported format contract; available in every native architecture.
#[unsafe(no_mangle)]
pub extern "C" fn board_renderer_gpu_atlas_format_version() -> u32 {
    2
}

/// Prepare GPU pixels and the small JSON manifest as independently owned
/// allocations. A local optional geometry file is only an acceleration hint:
/// missing, incompatible or corrupt data falls back to normal preparation.
///
/// # Safety
/// Inputs identify readable bytes; all four outputs must be writable. Free
/// each returned allocation independently with `board_renderer_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_prepare_gpu_atlas_owned(
    config_json: *const u8,
    config_json_len: u32,
    asset_path: *const u8,
    asset_path_len: u32,
    expected_sha: *const u8,
    expected_sha_len: u32,
    generated_dir: *const u8,
    generated_dir_len: u32,
    out_manifest: *mut *mut u8,
    out_manifest_len: *mut u32,
    out_pixels: *mut *mut u8,
    out_pixels_len: *mut u32,
) -> i32 {
    if out_manifest.is_null()
        || out_manifest_len.is_null()
        || out_pixels.is_null()
        || out_pixels_len.is_null()
    {
        return -1;
    }
    unsafe {
        *out_manifest = std::ptr::null_mut();
        *out_manifest_len = 0;
        *out_pixels = std::ptr::null_mut();
        *out_pixels_len = 0;
    }
    if config_json.is_null()
        || config_json_len > 8 * 1024 * 1024
        || asset_path_len > 4096
        || generated_dir_len > 4096
        || expected_sha_len > 64
    {
        return -1;
    }
    let bytes = unsafe { slice::from_raw_parts(config_json, config_json_len as usize) };
    let Ok(config) = serde_json::from_slice::<RenderConfig>(bytes) else {
        return -1;
    };
    // Optional paths are UTF-8, never nul-terminated strings. Invalid hints
    // disappear; they cannot prevent the normal local renderer fallback.
    let path = if !asset_path.is_null() && asset_path_len > 0 {
        std::str::from_utf8(unsafe { slice::from_raw_parts(asset_path, asset_path_len as usize) })
            .ok()
    } else {
        None
    };
    let expected = if !expected_sha.is_null() && expected_sha_len > 0 {
        std::str::from_utf8(unsafe {
            slice::from_raw_parts(expected_sha, expected_sha_len as usize)
        })
        .ok()
    } else {
        None
    };
    let directory = if !generated_dir.is_null() && generated_dir_len > 0 {
        std::str::from_utf8(unsafe {
            slice::from_raw_parts(generated_dir, generated_dir_len as usize)
        })
        .ok()
    } else {
        None
    };
    let prepared = match board_renderer_core::aura::gpu_atlas::prepare_cached(
        &config,
        path.zip(expected)
            .map(|(path, expected)| (std::path::Path::new(path), expected)),
        directory.map(std::path::Path::new),
    ) {
        Ok(prepared) => prepared,
        Err(_) => return -2,
    };
    if prepared.manifest.is_empty()
        || prepared.pixels.is_empty()
        || prepared.manifest.len() > 4 * 1024 * 1024
        || prepared.pixels.len() > 128 * 1024 * 1024
    {
        return -2;
    }
    let (manifest, manifest_length) = transfer_gpu_allocation(prepared.manifest);
    let (pixels, pixels_length) = transfer_gpu_allocation(prepared.pixels);
    unsafe {
        *out_manifest = manifest;
        *out_manifest_len = manifest_length;
        *out_pixels = pixels;
        *out_pixels_len = pixels_length;
    }
    0
}

/// Prepare the experimental GPU story's immutable layout atlas.
/// Returns 0 on success, -1 for invalid input, -2 for unsupported/budgeted layouts.
/// The result is owned by the caller and freed with `board_renderer_free`.
///
/// # Safety
/// Input must identify readable bytes, and output pointers must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_prepare_gpu_atlas(
    config_json: *const u8,
    config_json_len: u32,
    out_data: *mut *mut u8,
    out_len: *mut u32,
) -> i32 {
    if config_json.is_null() || out_data.is_null() || out_len.is_null() {
        return -1;
    }
    unsafe {
        *out_data = std::ptr::null_mut();
        *out_len = 0;
    }
    let bytes = unsafe { slice::from_raw_parts(config_json, config_json_len as usize) };
    let Ok(config) = serde_json::from_slice::<RenderConfig>(bytes) else {
        return -1;
    };
    match board_renderer_core::aura::gpu_atlas::prepare(&config) {
        Ok(bytes) => {
            let mut bytes = bytes.into_boxed_slice();
            unsafe {
                *out_data = bytes.as_mut_ptr();
                *out_len = bytes.len() as u32;
            }
            std::mem::forget(bytes);
            0
        }
        Err(_) => -2,
    }
}

/// Render a board overlay from a JSON config string.
///
/// Returns 0 on success, -1 on JSON parse error, -2 on render error.
/// On success, `out_data` points to heap-allocated RGBA pixel data,
/// `out_len` is the byte length, and `out_width`/`out_height` are dimensions.
/// The caller must free the data with `board_renderer_free`.
///
/// # Safety
/// `config_json` must point to `config_json_len` readable bytes (or be null,
/// which returns -1), and every `out_*` pointer must be null or valid for a
/// write of its pointee type. The returned buffer is owned by the caller until
/// it is handed back to `board_renderer_free` with the same `out_len`.
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

/// Free one independently owned renderer allocation.
///
/// # Safety
/// `ptr` must have been returned by a renderer entry point, exactly once, with
/// its matching `out_len`. Owned GPU buffers retain their original Vec capacity
/// in the registry. Legacy render/packed-atlas buffers are boxed slices.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    let original_allocation = {
        let mut allocations = OWNED_GPU_ALLOCATIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match allocations.get(&(ptr as usize)) {
            // Never reconstruct a registered Vec using mismatched metadata.
            Some((length, _)) if *length != len as usize => return,
            Some(_) => allocations.remove(&(ptr as usize)),
            None => None,
        }
    };
    if let Some((length, capacity)) = original_allocation {
        drop(unsafe { Vec::from_raw_parts(ptr, length, capacity) });
    } else if len > 0 {
        let slice = unsafe { slice::from_raw_parts_mut(ptr, len as usize) };
        drop(unsafe { Box::from_raw(slice as *mut [u8]) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    // Only allocation-registry tests need serialization; legacy PNG tests do
    // not publish entries and can still run concurrently.
    static OWNED_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn exported_gpu_atlas_format_version_matches_the_decoder_contract() {
        assert_eq!(board_renderer_gpu_atlas_format_version(), 2);
    }

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
    fn owned_atlas_buffers_are_independent_and_invalid_asset_is_optional() {
        let _guard = OWNED_TEST_LOCK.lock().unwrap();
        let json = minimal_config_json().replace(
            "\"frames\": \"\"",
            "\"render_mode\": \"aura\", \"mark_style\": \"glow\", \"frames\": \"\"",
        );
        let path = b"/missing/optional/aura-file";
        let hash = [b'0'; 64];
        let mut manifest = ptr::null_mut();
        let mut manifest_len = 0;
        let mut pixels = ptr::null_mut();
        let mut pixels_len = 0;
        let result = unsafe {
            board_renderer_prepare_gpu_atlas_owned(
                json.as_ptr(),
                json.len() as u32,
                path.as_ptr(),
                path.len() as u32,
                hash.as_ptr(),
                hash.len() as u32,
                ptr::null(),
                0,
                &mut manifest,
                &mut manifest_len,
                &mut pixels,
                &mut pixels_len,
            )
        };
        assert_eq!(result, 0);
        assert_ne!(manifest, pixels);
        let parsed: serde_json::Value = serde_json::from_slice(unsafe {
            slice::from_raw_parts(manifest, manifest_len as usize)
        })
        .unwrap();
        assert_eq!(parsed["version"], 2);
        unsafe {
            board_renderer_free(manifest, manifest_len);
        }
        assert!(pixels_len >= 4);
        let owned_pixels = unsafe { slice::from_raw_parts(pixels, pixels_len as usize) };
        assert_eq!(&owned_pixels[..4], &[0, 0, 0, 0]);
        unsafe {
            board_renderer_free(pixels, pixels_len);
        }
    }

    #[test]
    fn owned_transfer_preserves_spare_capacity_and_frees_buffers_independently() {
        let _guard = OWNED_TEST_LOCK.lock().unwrap();
        let mut manifest = Vec::with_capacity(4096);
        manifest.extend_from_slice(b"manifest");
        let original_manifest_pointer = manifest.as_mut_ptr();
        let manifest_capacity = manifest.capacity();
        let mut pixels = Vec::with_capacity(8192);
        pixels.extend_from_slice(&[1_u8, 2, 3, 4]);
        let original_pixels_pointer = pixels.as_mut_ptr();
        let pixels_capacity = pixels.capacity();
        let (manifest_pointer, manifest_length) = transfer_gpu_allocation(manifest);
        let (pixels_pointer, pixels_length) = transfer_gpu_allocation(pixels);
        assert_eq!(manifest_pointer, original_manifest_pointer);
        assert_eq!(pixels_pointer, original_pixels_pointer);
        assert!(manifest_capacity > manifest_length as usize);
        assert!(pixels_capacity > pixels_length as usize);
        {
            let allocations = OWNED_GPU_ALLOCATIONS.lock().unwrap();
            assert_eq!(
                allocations[&(manifest_pointer as usize)],
                (8, manifest_capacity)
            );
            assert_eq!(
                allocations[&(pixels_pointer as usize)],
                (4, pixels_capacity)
            );
        }
        unsafe {
            board_renderer_free(manifest_pointer, manifest_length);
        }
        {
            let allocations = OWNED_GPU_ALLOCATIONS.lock().unwrap();
            assert!(!allocations.contains_key(&(manifest_pointer as usize)));
            assert!(allocations.contains_key(&(pixels_pointer as usize)));
        }
        assert_eq!(
            unsafe { slice::from_raw_parts(pixels_pointer, 4) },
            &[1, 2, 3, 4]
        );
        // A mismatched length cannot consume the entry or use Box metadata.
        unsafe {
            board_renderer_free(pixels_pointer, pixels_length + 1);
        }
        assert!(
            OWNED_GPU_ALLOCATIONS
                .lock()
                .unwrap()
                .contains_key(&(pixels_pointer as usize))
        );
        unsafe {
            board_renderer_free(pixels_pointer, pixels_length);
        }
        // Other tests add and free entries in the same global map in parallel, so
        // check only this test's own pointers, never the map's length.
        assert!(
            !OWNED_GPU_ALLOCATIONS
                .lock()
                .unwrap()
                .contains_key(&(pixels_pointer as usize))
        );
    }

    #[test]
    fn owned_atlas_rejection_resets_both_allocations() {
        let mut manifest = ptr::dangling_mut();
        let mut manifest_len = 42;
        let mut pixels = ptr::dangling_mut();
        let mut pixels_len = 42;
        let result = unsafe {
            board_renderer_prepare_gpu_atlas_owned(
                ptr::null(),
                0,
                ptr::null(),
                0,
                ptr::null(),
                0,
                ptr::null(),
                0,
                &mut manifest,
                &mut manifest_len,
                &mut pixels,
                &mut pixels_len,
            )
        };
        assert_eq!(result, -1);
        assert!(manifest.is_null() && pixels.is_null());
        assert_eq!(manifest_len, 0);
        assert_eq!(pixels_len, 0);
    }

    #[test]
    fn gpu_atlas_rejects_invalid_input_and_resets_output() {
        let mut output = std::ptr::dangling_mut::<u8>();
        let mut length = 42;
        let invalid = b"invalid";
        let result = unsafe {
            board_renderer_prepare_gpu_atlas(
                invalid.as_ptr(),
                invalid.len() as u32,
                &mut output,
                &mut length,
            )
        };
        assert_eq!(result, -1);
        assert!(output.is_null());
        assert_eq!(length, 0);
    }

    #[test]
    fn gpu_atlas_roundtrip_uses_matching_allocator() {
        let json = minimal_config_json().replace(
            "\"frames\": \"\"",
            "\"render_mode\": \"aura\", \"mark_style\": \"glow\", \"frames\": \"\"",
        );
        let mut output = std::ptr::null_mut();
        let mut length = 0;
        let result = unsafe {
            board_renderer_prepare_gpu_atlas(
                json.as_ptr(),
                json.len() as u32,
                &mut output,
                &mut length,
            )
        };
        assert_eq!(result, 0);
        assert!(length > 4);
        unsafe {
            board_renderer_free(output, length);
        }
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
