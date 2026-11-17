//! Numeric, leased lazy-packet ABI. Never hold the registry during rasterization.
use std::collections::HashMap;
use std::slice;
use std::sync::{Arc, LazyLock, Mutex};

use board_renderer_core::aura::gpu_packet::{
    self, Cancellation, ChunkLayout, Packet, Plan, Reveal, Session,
};
use serde::Deserialize;
use serde_json::json;

#[repr(C)]
#[derive(Default)]
pub struct AuraGpuBytes {
    pub pointer: *mut u8,
    pub length: u32,
}
#[repr(C)]
#[derive(Default)]
pub struct AuraGpuPlan {
    pub handle: u64,
    pub header: AuraGpuBytes,
}
#[repr(C)]
#[derive(Default)]
pub struct AuraGpuChunks {
    pub header: AuraGpuBytes,
    pub pixels: AuraGpuBytes,
    pub handles: AuraGpuBytes,
}
#[repr(C)]
#[derive(Default)]
pub struct AuraGpuPacket {
    pub handle: u64,
    pub header: AuraGpuBytes,
    pub descriptors: AuraGpuBytes,
    pub resources: AuraGpuBytes,
}

#[derive(Clone)]
enum Lease {
    Session(Arc<Session>),
    Plan(Arc<Mutex<Plan>>),
    Chunk(Arc<ChunkLayout>),
    Packet(Arc<Packet>),
    Cancel(Arc<Cancellation>),
}
#[derive(Default)]
struct Registry {
    next: u64,
    handles: HashMap<u64, Lease>,
}
impl Registry {
    fn insert(&mut self, lease: Lease) -> Result<u64, String> {
        if self.handles.len() >= 16384 {
            return Err("handle limit".into());
        }
        self.next = self
            .next
            .checked_add(1)
            .filter(|id| *id <= i64::MAX as u64)
            .ok_or("handle sequence exhausted")?;
        self.handles.insert(self.next, lease);
        Ok(self.next)
    }
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));
fn lookup(handle: u64) -> Result<Lease, String> {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .handles
        .get(&handle)
        .cloned()
        .ok_or("closed handle".into())
}
fn cancellation(handle: u64) -> Result<Arc<Cancellation>, String> {
    match lookup(handle)? {
        Lease::Cancel(cancel) => Ok(cancel),
        _ => Err("wrong handle kind".into()),
    }
}
fn guarded<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    #[cfg(panic = "unwind")]
    {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
            .unwrap_or_else(|_| Err("GPU packet preparation panicked".into()))
    }
    #[cfg(panic = "abort")]
    {
        operation()
    }
}
/// Rolls back unpublished leases on ordinary errors and unwind-mode panics.
#[derive(Default)]
struct PendingHandles {
    ids: Vec<u64>,
    committed: bool,
}
impl Drop for PendingHandles {
    fn drop(&mut self) {
        if !self.committed {
            let mut registry = REGISTRY
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for id in &self.ids {
                registry.handles.remove(id);
            }
        }
    }
}
struct PendingBytes(Option<AuraGpuBytes>);
impl PendingBytes {
    fn new(bytes: Vec<u8>) -> Self {
        Self(Some(owned(bytes)))
    }
    fn publish(mut self) -> AuraGpuBytes {
        self.0.take().unwrap_or_default()
    }
}
impl Drop for PendingBytes {
    fn drop(&mut self) {
        if let Some(bytes) = self.0.take() {
            unsafe {
                super::board_renderer_free(bytes.pointer, bytes.length);
            }
        }
    }
}
#[cfg(test)]
static PANIC_PREPARE_AFTER_HEADER: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
static PANIC_HEADER_POINTER: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
fn status(error: &str) -> i32 {
    if error == "cancelled" {
        -3
    } else if error == "handle limit"
        || error == "handle sequence exhausted"
        || error.contains("too many live")
    {
        -5
    } else if error == "GPU packet preparation panicked" {
        -6
    } else if error.contains("handle") {
        -4
    } else if error.contains("exceeds") || error.to_ascii_lowercase().contains("unsupported") {
        -2
    } else {
        -1
    }
}
fn owned(bytes: Vec<u8>) -> AuraGpuBytes {
    if bytes.is_empty() {
        return AuraGpuBytes::default();
    }
    let (pointer, length) = super::transfer_gpu_allocation(bytes);
    AuraGpuBytes { pointer, length }
}
fn header(value: serde_json::Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    if bytes.len() > gpu_packet::MAX_HEADER_BYTES {
        Err("header exceeds 256 KiB".into())
    } else {
        Ok(bytes)
    }
}
unsafe fn input<'a>(pointer: *const u8, length: u32, limit: usize) -> Result<&'a [u8], String> {
    if length as usize > limit || pointer.is_null() {
        return Err("invalid input buffer".into());
    }
    Ok(unsafe { slice::from_raw_parts(pointer, length as usize) })
}

#[unsafe(no_mangle)]
pub extern "C" fn board_renderer_gpu_packet_api_version() -> u32 {
    gpu_packet::PACKET_VERSION
}

/// # Safety
/// Output must point to a writable u64. The caller closes every returned handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_cancel_create(output: *mut u64) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = 0;
    }
    match REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(Lease::Cancel(Arc::new(Cancellation::default())))
    {
        Ok(handle) => {
            unsafe {
                *output = handle;
            }
            0
        }
        Err(error) => status(&error),
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn board_renderer_gpu_cancel(handle: u64) {
    if let Ok(cancel) = cancellation(handle) {
        cancel.cancel();
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn board_renderer_gpu_handle_close(handle: u64) {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .handles
        .remove(&handle);
}

/// # Safety
/// JSON identifies length readable bytes; output is writable. No pixel work occurs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_session_create(
    config: *const u8,
    length: u32,
    cancel: u64,
    output: *mut u64,
) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = 0;
    }
    let result: Result<_, String> = guarded(|| {
        let cancel = cancellation(cancel)?;
        let session =
            Session::from_json(unsafe { input(config, length, 8 * 1024 * 1024)? }, &cancel)?;
        cancel.check()?;
        REGISTRY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(Lease::Session(session))
    });
    match result {
        Ok(handle) => {
            unsafe {
                *output = handle;
            }
            0
        }
        Err(error) => status(&error),
    }
}

/// Optional private local cache setup. No filesystem access occurs here.
/// # Safety
/// Path identifies length UTF-8 bytes and ends in the native-owned aura-lazy-v1 directory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_session_set_cache_directory(
    session: u64,
    path: *const u8,
    length: u32,
) -> i32 {
    let result: Result<_, String> = guarded(|| {
        let Lease::Session(session) = lookup(session)? else {
            return Err("wrong session handle".into());
        };
        let path = std::str::from_utf8(unsafe { input(path, length, 4096)? })
            .map_err(|error| error.to_string())?;
        if path.contains('\0') {
            return Err("invalid cache path".into());
        }
        session.set_cache_directory(std::path::PathBuf::from(path))
    });
    match result {
        Ok(()) => 0,
        Err(error) => status(&error),
    }
}
/// Call only after an accepted ready drawable; bounded nonblocking queue.
#[unsafe(no_mangle)]
pub extern "C" fn board_renderer_gpu_session_schedule_persist(session: u64) -> i32 {
    match guarded(|| match lookup(session)? {
        Lease::Session(session) => Ok(session.schedule_persist()),
        _ => Err("wrong session handle".into()),
    }) {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(error) => status(&error),
    }
}

/// # Safety
/// Request identifies length readable bytes; output is writable and initially unowned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_plan_create(
    session: u64,
    request: *const u8,
    length: u32,
    cancel: u64,
    output: *mut AuraGpuPlan,
) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = AuraGpuPlan::default();
    }
    let result: Result<_, String> = guarded(|| {
        let Lease::Session(session) = lookup(session)? else {
            return Err("wrong session handle".into());
        };
        let cancel = cancellation(cancel)?;
        let request = serde_json::from_slice(unsafe { input(request, length, 128 * 1024)? })
            .map_err(|error| error.to_string())?;
        let plan = Plan::new(session, request, &cancel)?;
        let description = header(plan.describe())?;
        cancel.check()?;
        let handle = REGISTRY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(Lease::Plan(Arc::new(Mutex::new(plan))))?;
        Ok((handle, description))
    });
    match result {
        Ok((handle, description)) => {
            unsafe {
                *output = AuraGpuPlan {
                    handle,
                    header: owned(description),
                };
            }
            0
        }
        Err(error) => status(&error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResidentChunks {
    chunks: Vec<u64>,
}

/// # Safety
/// Resident JSON contains metadata handles already pinned in the native arena.
/// Outputs transfer only missing chunks. Free each buffer with board_renderer_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_plan_prepare(
    plan: u64,
    resident: *const u8,
    length: u32,
    cancel: u64,
    output: *mut AuraGpuChunks,
) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = AuraGpuChunks::default();
    }
    let result: Result<_, String> = guarded(|| {
        let Lease::Plan(plan) = lookup(plan)? else {
            return Err("wrong plan handle".into());
        };
        let cancel = cancellation(cancel)?;
        let resident: ResidentChunks =
            serde_json::from_slice(unsafe { input(resident, length, 256 * 1024)? })
                .map_err(|error| error.to_string())?;
        if resident.chunks.len() > 769 {
            return Err("too many resident chunks".into());
        }
        let resident = resident
            .chunks
            .into_iter()
            .map(|handle| match lookup(handle)? {
                Lease::Chunk(layout) => Ok(layout),
                _ => Err("wrong chunk handle".into()),
            })
            .collect::<Result<Vec<_>, String>>()?;
        let (prepared, sources) = {
            let mut plan = plan.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let prepared = plan.prepare(&resident, &cancel)?;
            (prepared, plan.sources)
        };
        cancel.check()?;
        let mut pending = PendingHandles::default();
        let mut registry = REGISTRY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry.handles.len().saturating_add(prepared.chunks.len()) > 16384 {
            return Err("handle limit".into());
        }
        let mut records = Vec::new();
        for chunk in &prepared.chunks {
            match registry.insert(Lease::Chunk(chunk.layout.clone())) {
                Ok(handle) => {
                    pending.ids.push(handle);
                    records.push(json!({"handle":handle,"key":chunk.layout.key,"bytes":chunk.layout.bytes,"sourceOffset":chunk.source_offset}));
                }
                Err(error) => return Err(error),
            }
        }
        let description = match header(
            json!({"version":1,"chunks":records,"pixelBytes":prepared.bytes.len(),"preparation_sources":sources}),
        ) {
            Ok(description) => description,
            Err(error) => return Err(error),
        };
        drop(registry);
        cancel.check()?;
        let handles = pending
            .ids
            .iter()
            .flat_map(|handle| handle.to_le_bytes())
            .collect();
        let description = PendingBytes::new(description);
        #[cfg(test)]
        if PANIC_PREPARE_AFTER_HEADER.swap(false, std::sync::atomic::Ordering::AcqRel) {
            PANIC_HEADER_POINTER.store(
                description
                    .0
                    .as_ref()
                    .map(|bytes| bytes.pointer as usize)
                    .unwrap_or(0),
                std::sync::atomic::Ordering::Release,
            );
            panic!("injected unpublished GPU buffer failure");
        }
        Ok((
            pending,
            description,
            PendingBytes::new(prepared.bytes),
            PendingBytes::new(handles),
        ))
    });
    match result {
        Ok((mut pending, description, pixels, handles)) => {
            unsafe {
                *output = AuraGpuChunks {
                    header: description.publish(),
                    pixels: pixels.publish(),
                    handles: handles.publish(),
                };
            }
            pending.committed = true;
            0
        }
        Err(error) => status(&error),
    }
}

/// # Safety
/// Placement JSON identifies stable pinned arena ranges; outputs are writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_plan_encode(
    plan: u64,
    placements: *const u8,
    length: u32,
    cancel: u64,
    output: *mut AuraGpuPacket,
) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = AuraGpuPacket::default();
    }
    let result: Result<_, String> = guarded(|| {
        let Lease::Plan(plan) = lookup(plan)? else {
            return Err("wrong plan handle".into());
        };
        let cancel = cancellation(cancel)?;
        let placements = serde_json::from_slice(unsafe { input(placements, length, 256 * 1024)? })
            .map_err(|error| error.to_string())?;
        let mut packet = plan
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .encode(placements, &cancel)?;
        let description = header(packet.describe())?;
        if description.len() > 64 * 1024 {
            return Err("packet header exceeds 64 KiB".into());
        }
        let descriptors = std::mem::take(&mut packet.descriptors);
        let resources = std::mem::take(&mut packet.resources);
        cancel.check()?;
        let handle = REGISTRY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(Lease::Packet(Arc::new(packet)))?;
        Ok((handle, description, descriptors, resources))
    });
    match result {
        Ok((handle, description, descriptors, resources)) => {
            unsafe {
                *output = AuraGpuPacket {
                    handle,
                    header: owned(description),
                    descriptors: owned(descriptors),
                    resources: owned(resources),
                };
            }
            0
        }
        Err(error) => status(&error),
    }
}

/// Allocation-free frame path. Slot0=current,1=previous,2=next.
/// `reveal_mode` 0 wipes with `progress`; 1 swaps, weighting lower-only,
/// upper-only and shared same-role holds by `swap_lower`, `swap_upper` and
/// `swap_shared`. Each mode ignores the other's values.
/// # Safety
/// Output identifies exactly144 writable bytes; length must be144.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_packet_shared_reveal_uniforms(
    packet: u64,
    lower: u32,
    upper: u32,
    reveal_mode: u32,
    progress: f32,
    swap_lower: f32,
    swap_upper: f32,
    swap_shared: f32,
    pulse: f32,
    viewport_width: f32,
    viewport_height: f32,
    production_empty: u32,
    mirrored: u32,
    output: *mut u8,
    length: u32,
) -> i32 {
    if output.is_null()
        || length != gpu_packet::UNIFORM_BYTES as u32
        || production_empty > 1
        || mirrored > 1
    {
        return -1;
    }
    let result: Result<_, String> = guarded(|| {
        let Lease::Packet(packet) = lookup(packet)? else {
            return Err("wrong packet handle".into());
        };
        let reveal =
            Reveal::from_native(reveal_mode, progress, swap_lower, swap_upper, swap_shared)?;
        let output = unsafe { &mut *(output as *mut [u8; gpu_packet::UNIFORM_BYTES]) };
        packet.encode_uniforms(
            lower as usize,
            upper as usize,
            reveal,
            pulse,
            [viewport_width, viewport_height],
            production_empty == 1,
            mirrored == 1,
            output,
        )
    });
    match result {
        Ok(()) => 0,
        Err(error) => status(&error),
    }
}

/// # Safety
/// Output is a writable unowned AuraGpuBytes. The manifest is small and owned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_packet_contract(output: *mut AuraGpuBytes) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = AuraGpuBytes::default();
    }
    match header(gpu_packet::contract_manifest()) {
        Ok(bytes) => {
            unsafe {
                *output = owned(bytes);
            }
            0
        }
        Err(error) => status(&error),
    }
}

/// Read-only process-cumulative work, including cancelled preparations.
/// # Safety
/// Output is writable and unowned; free with board_renderer_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_renderer_gpu_packet_stats(output: *mut AuraGpuBytes) -> i32 {
    if output.is_null() {
        return -1;
    }
    unsafe {
        *output = AuraGpuBytes::default();
    }
    let result = guarded(|| {
        header(
            serde_json::to_value(board_renderer_core::aura::gpu_packet_stats::snapshot())
                .map_err(|error| error.to_string())?,
        )
    });
    match result {
        Ok(bytes) => {
            unsafe {
                *output = owned(bytes);
            }
            0
        }
        Err(error) => status(&error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use board_renderer_core::aura::gpu_constants::{REVEAL_MODE_SWAP, REVEAL_MODE_WIPE};
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    fn fixture() -> Vec<u8> {
        serde_json::to_vec(&json!({"board_width":100,"board_height":100,"output_width":100,"frames":"p1r42",
        "thumbnail":false,"render_mode":"aura","holds":[{"id":1,"cx":30,"cy":50,"r":8},{"id":2,"cx":70,"cy":50,"r":12}],
        "hold_state_map":{"42":{"color":"#00FF00","role":"hand"}}})).unwrap()
    }
    unsafe fn decode(bytes: AuraGpuBytes) -> serde_json::Value {
        let value = serde_json::from_slice(unsafe {
            slice::from_raw_parts(bytes.pointer, bytes.length as usize)
        })
        .unwrap();
        unsafe {
            super::super::board_renderer_free(bytes.pointer, bytes.length);
        }
        value
    }
    fn start() -> (u64, u64) {
        let mut cancel = 0;
        assert_eq!(unsafe { board_renderer_gpu_cancel_create(&mut cancel) }, 0);
        let config = fixture();
        let mut session = 0;
        assert_eq!(
            unsafe {
                board_renderer_gpu_session_create(
                    config.as_ptr(),
                    config.len() as u32,
                    cancel,
                    &mut session,
                )
            },
            0
        );
        (cancel, session)
    }
    fn plan(session: u64, cancel: u64) -> u64 {
        let request = br#"{"current":"p1r42","next":"p2r42"}"#;
        let mut output = AuraGpuPlan::default();
        assert_eq!(
            unsafe {
                board_renderer_gpu_plan_create(
                    session,
                    request.as_ptr(),
                    request.len() as u32,
                    cancel,
                    &mut output,
                )
            },
            0
        );
        let header = unsafe { decode(output.header) };
        assert_eq!(header["version"], 1);
        assert_eq!(header["chunks"].as_array().unwrap().len(), 4);
        output.handle
    }
    #[test]
    fn closed_session_remains_leased_and_owned_buffers_are_independently_freed() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (cancel, session) = start();
        let plan = plan(session, cancel);
        board_renderer_gpu_handle_close(session);
        board_renderer_gpu_handle_close(session);
        let resident = br#"{"chunks":[]}"#;
        let mut chunks = AuraGpuChunks::default();
        assert_eq!(
            unsafe {
                board_renderer_gpu_plan_prepare(
                    plan,
                    resident.as_ptr(),
                    resident.len() as u32,
                    cancel,
                    &mut chunks,
                )
            },
            0
        );
        let description = unsafe { decode(chunks.header) };
        assert!(chunks.pixels.length > 0);
        assert!(
            super::super::OWNED_GPU_ALLOCATIONS
                .lock()
                .unwrap()
                .contains_key(&(chunks.pixels.pointer as usize))
        );
        let records = description["chunks"].as_array().unwrap();
        let mut cursor = 0;
        let placements = records
            .iter()
            .map(|chunk| {
                let entry = json!({"key":chunk["key"],"offset":cursor,"bytes":chunk["bytes"]});
                cursor += chunk["bytes"].as_u64().unwrap();
                entry
            })
            .collect::<Vec<_>>();
        let placements =
            serde_json::to_vec(&json!({"arena_bytes":cursor,"chunks":placements})).unwrap();
        let mut packet = AuraGpuPacket::default();
        assert_eq!(
            unsafe {
                board_renderer_gpu_plan_encode(
                    plan,
                    placements.as_ptr(),
                    placements.len() as u32,
                    cancel,
                    &mut packet,
                )
            },
            0
        );
        let header = unsafe { decode(packet.header) };
        assert_eq!(header["current_roles"], json!([[1, 42]]));
        assert_eq!(
            packet.descriptors.length,
            3 * gpu_packet::DESCRIPTOR_BYTES as u32
        );
        board_renderer_gpu_handle_close(plan);
        let mut uniforms = [0; 144];
        assert_eq!(
            unsafe {
                board_renderer_gpu_packet_shared_reveal_uniforms(
                    packet.handle,
                    0,
                    2,
                    REVEAL_MODE_WIPE,
                    0.5,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                    100.0,
                    100.0,
                    1,
                    0,
                    uniforms.as_mut_ptr(),
                    144,
                )
            },
            0
        );
        let swap = |mode: u32, lower: f32, upper: f32, shared: f32, uniforms: &mut [u8; 144]| unsafe {
            board_renderer_gpu_packet_shared_reveal_uniforms(
                packet.handle,
                0,
                2,
                mode,
                0.0,
                lower,
                upper,
                shared,
                1.0,
                100.0,
                100.0,
                1,
                0,
                uniforms.as_mut_ptr(),
                144,
            )
        };
        assert_eq!(swap(REVEAL_MODE_SWAP, 0.4, 0.25, 0.4, &mut uniforms), 0);
        let float =
            |offset: usize| f32::from_le_bytes(uniforms[offset..offset + 4].try_into().unwrap());
        assert_eq!(
            [float(60), float(88), float(92), float(104)],
            [0.4, 0.4, 0.25, 1.0]
        );
        let mut rejected = [7; 144];
        assert_eq!(swap(2, 0.4, 0.25, 1.0, &mut rejected), -1);
        assert_eq!(
            swap(REVEAL_MODE_SWAP, f32::NAN, 0.0, 1.0, &mut rejected),
            -1
        );
        assert_eq!(swap(REVEAL_MODE_SWAP, 0.0, 1.01, 1.0, &mut rejected), -1);
        assert_eq!(
            swap(REVEAL_MODE_SWAP, 0.4, 0.0, f32::NAN, &mut rejected),
            -1
        );
        assert_eq!(swap(REVEAL_MODE_SWAP, 0.4, 0.0, 1.01, &mut rejected), -1);
        for bytes in [
            chunks.pixels,
            chunks.handles,
            packet.descriptors,
            packet.resources,
        ] {
            unsafe {
                super::super::board_renderer_free(bytes.pointer, bytes.length);
            }
        }
        for record in records {
            board_renderer_gpu_handle_close(record["handle"].as_u64().unwrap());
        }
        board_renderer_gpu_handle_close(packet.handle);
        board_renderer_gpu_handle_close(cancel);
        assert_eq!(
            unsafe {
                board_renderer_gpu_packet_shared_reveal_uniforms(
                    packet.handle,
                    0,
                    2,
                    REVEAL_MODE_WIPE,
                    0.5,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                    100.0,
                    100.0,
                    1,
                    0,
                    uniforms.as_mut_ptr(),
                    144,
                )
            },
            -4
        );
    }
    #[test]
    fn cancelled_batch_resets_all_outputs_and_publishes_no_handles() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (cancel, session) = start();
        let plan = plan(session, cancel);
        let before = REGISTRY.lock().unwrap().handles.len();
        board_renderer_gpu_cancel(cancel);
        let resident = br#"{"chunks":[]}"#;
        let mut output = AuraGpuChunks {
            header: AuraGpuBytes {
                pointer: std::ptr::dangling_mut::<u8>(),
                length: 99,
            },
            pixels: AuraGpuBytes {
                pointer: std::ptr::dangling_mut::<u8>(),
                length: 99,
            },
            handles: AuraGpuBytes {
                pointer: std::ptr::dangling_mut::<u8>(),
                length: 99,
            },
        };
        assert_eq!(
            unsafe {
                board_renderer_gpu_plan_prepare(
                    plan,
                    resident.as_ptr(),
                    resident.len() as u32,
                    cancel,
                    &mut output,
                )
            },
            -3
        );
        assert!(output.header.pointer.is_null() && output.pixels.pointer.is_null());
        assert_eq!(output.header.length + output.pixels.length, 0);
        assert_eq!(REGISTRY.lock().unwrap().handles.len(), before);
        for handle in [plan, session, cancel] {
            board_renderer_gpu_handle_close(handle);
        }
    }
    #[test]
    fn numeric_handles_never_reuse_and_wrong_kinds_are_rejected() {
        let _serial = TEST_LOCK.lock().unwrap();
        let mut first = 0;
        assert_eq!(unsafe { board_renderer_gpu_cancel_create(&mut first) }, 0);
        board_renderer_gpu_handle_close(first);
        let mut second = 0;
        assert_eq!(unsafe { board_renderer_gpu_cancel_create(&mut second) }, 0);
        assert!(second > first);
        let request = br#"{"current":""}"#;
        let mut output = AuraGpuPlan::default();
        assert_eq!(
            unsafe {
                board_renderer_gpu_plan_create(
                    second,
                    request.as_ptr(),
                    request.len() as u32,
                    second,
                    &mut output,
                )
            },
            -4
        );
        assert_eq!(output.handle, 0);
        assert!(output.header.pointer.is_null());
        board_renderer_gpu_handle_close(second);
    }
    #[test]
    fn actual_live_session_limit_cannot_be_bypassed_by_closing_registry_ids() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (cancel, session) = start();
        let plan = plan(session, cancel);
        board_renderer_gpu_handle_close(session);
        let config = fixture();
        let mut sessions = Vec::new();
        for _ in 0..7 {
            let mut session = 0;
            assert_eq!(
                unsafe {
                    board_renderer_gpu_session_create(
                        config.as_ptr(),
                        config.len() as u32,
                        cancel,
                        &mut session,
                    )
                },
                0
            );
            sessions.push(session);
        }
        let mut rejected = 99;
        assert_eq!(
            unsafe {
                board_renderer_gpu_session_create(
                    config.as_ptr(),
                    config.len() as u32,
                    cancel,
                    &mut rejected,
                )
            },
            -5
        );
        assert_eq!(rejected, 0);
        board_renderer_gpu_handle_close(plan);
        assert_eq!(
            unsafe {
                board_renderer_gpu_session_create(
                    config.as_ptr(),
                    config.len() as u32,
                    cancel,
                    &mut rejected,
                )
            },
            0
        );
        sessions.push(rejected);
        for session in sessions {
            board_renderer_gpu_handle_close(session);
        }
        board_renderer_gpu_handle_close(cancel);
    }
    #[test]
    fn stats_snapshot_is_bounded_owned_and_explicitly_reports_availability() {
        let _serial = TEST_LOCK.lock().unwrap();
        let mut first = AuraGpuBytes::default();
        let mut second = AuraGpuBytes::default();
        assert_eq!(unsafe { board_renderer_gpu_packet_stats(&mut first) }, 0);
        assert_eq!(unsafe { board_renderer_gpu_packet_stats(&mut second) }, 0);
        assert!(first.length > 0 && first.length <= 4096);
        assert!(second.length <= 4096);
        assert_ne!(first.pointer, second.pointer);
        let snapshot = unsafe { decode(first) };
        assert_eq!(snapshot["available"], true);
        assert_eq!(snapshot["version"], 1);
        assert_eq!(snapshot["panicGuardEnabled"], cfg!(panic = "unwind"));
        for key in [
            "fieldRasterAttempts",
            "fieldRasterCompleted",
            "roleRasterAttempts",
            "roleRasterCompleted",
            "cpuCacheHits",
            "localCacheHits",
            "localCacheCorrupt",
            "pendingPreparationPhases",
            "pendingCacheWrites",
        ] {
            assert!(snapshot[key].as_u64().is_some(), "{key}");
        }
        assert!(
            super::super::OWNED_GPU_ALLOCATIONS
                .lock()
                .unwrap()
                .contains_key(&(second.pointer as usize))
        );
        unsafe {
            super::super::board_renderer_free(second.pointer, second.length);
        }
    }
    #[test]
    #[cfg(panic = "unwind")]
    fn logical_panic_releases_unpublished_native_buffer_and_metadata_leases() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (cancel, session) = start();
        let plan = plan(session, cancel);
        let before = REGISTRY.lock().unwrap().handles.len();
        PANIC_PREPARE_AFTER_HEADER.store(true, std::sync::atomic::Ordering::Release);
        let resident = br#"{"chunks":[]}"#;
        let mut output = AuraGpuChunks::default();
        assert_eq!(
            unsafe {
                board_renderer_gpu_plan_prepare(
                    plan,
                    resident.as_ptr(),
                    resident.len() as u32,
                    cancel,
                    &mut output,
                )
            },
            -6
        );
        assert!(
            output.header.pointer.is_null()
                && output.pixels.pointer.is_null()
                && output.handles.pointer.is_null()
        );
        assert_eq!(
            REGISTRY
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .handles
                .len(),
            before
        );
        let pointer = PANIC_HEADER_POINTER.load(std::sync::atomic::Ordering::Acquire);
        assert!(pointer != 0);
        assert!(
            !super::super::OWNED_GPU_ALLOCATIONS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(&pointer)
        );
        for handle in [plan, session, cancel] {
            board_renderer_gpu_handle_close(handle);
        }
    }
}
