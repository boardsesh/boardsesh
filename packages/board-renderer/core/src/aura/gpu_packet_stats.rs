//! Process-cumulative work counters, including work retired by cancellation.
//! No per-frame/per-pixel counters; native owns upload/fence accounting.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

static FIELD_ATTEMPTS: AtomicU64 = AtomicU64::new(0);
static FIELD_COMPLETED: AtomicU64 = AtomicU64::new(0);
static ROLE_ATTEMPTS: AtomicU64 = AtomicU64::new(0);
static ROLE_COMPLETED: AtomicU64 = AtomicU64::new(0);
static CPU_HITS: AtomicU64 = AtomicU64::new(0);
static LOCAL_HITS: AtomicU64 = AtomicU64::new(0);
static LOCAL_CORRUPT: AtomicU64 = AtomicU64::new(0);
static LOCAL_MISSES: AtomicU64 = AtomicU64::new(0);
static PREPARATIONS: AtomicUsize = AtomicUsize::new(0);
static WRITES: AtomicUsize = AtomicUsize::new(0);
static EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub available: bool,
    pub panic_guard_enabled: bool,
    pub field_raster_attempts: u64,
    pub field_raster_completed: u64,
    pub role_raster_attempts: u64,
    pub role_raster_completed: u64,
    pub cpu_field_materializations: u64,
    pub cpu_role_materializations: u64,
    pub cpu_cache_hits: u64,
    pub local_cache_hits: u64,
    pub local_cache_corrupt: u64,
    pub local_cache_misses: u64,
    pub pending_preparation_phases: usize,
    pub pending_cache_writes: usize,
    pub activity_epoch: u64,
    pub drained: bool,
}
pub fn snapshot() -> Snapshot {
    let before = EPOCH.load(Ordering::Acquire);
    let fields = FIELD_COMPLETED.load(Ordering::Acquire);
    let roles = ROLE_COMPLETED.load(Ordering::Acquire);
    let mut snapshot = Snapshot {
        version: 1,
        available: true,
        panic_guard_enabled: cfg!(panic = "unwind"),
        field_raster_attempts: FIELD_ATTEMPTS.load(Ordering::Relaxed),
        field_raster_completed: fields,
        role_raster_attempts: ROLE_ATTEMPTS.load(Ordering::Relaxed),
        role_raster_completed: roles,
        cpu_field_materializations: fields,
        cpu_role_materializations: roles,
        cpu_cache_hits: CPU_HITS.load(Ordering::Relaxed),
        local_cache_hits: LOCAL_HITS.load(Ordering::Relaxed),
        local_cache_corrupt: LOCAL_CORRUPT.load(Ordering::Relaxed),
        local_cache_misses: LOCAL_MISSES.load(Ordering::Relaxed),
        pending_preparation_phases: PREPARATIONS.load(Ordering::Acquire),
        pending_cache_writes: WRITES.load(Ordering::Acquire),
        activity_epoch: 0,
        drained: false,
    };
    let after = EPOCH.load(Ordering::Acquire);
    snapshot.activity_epoch = after;
    snapshot.drained = before == after
        && snapshot.pending_preparation_phases == 0
        && snapshot.pending_cache_writes == 0;
    snapshot
}
pub(super) struct Work(&'static AtomicUsize);
impl Drop for Work {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
        EPOCH.fetch_add(1, Ordering::Release);
    }
}
fn begin(counter: &'static AtomicUsize) -> Work {
    counter.fetch_add(1, Ordering::AcqRel);
    EPOCH.fetch_add(1, Ordering::Release);
    Work(counter)
}
pub(super) fn preparation() -> Work {
    begin(&PREPARATIONS)
}
pub(super) fn cache_write() -> Work {
    begin(&WRITES)
}
pub(super) fn cpu_hit() {
    CPU_HITS.fetch_add(1, Ordering::Relaxed);
}
pub(super) fn local_hit() {
    LOCAL_HITS.fetch_add(1, Ordering::Relaxed);
}
pub(super) fn local_corrupt() {
    LOCAL_CORRUPT.fetch_add(1, Ordering::Relaxed);
}
pub(super) fn local_miss() {
    LOCAL_MISSES.fetch_add(1, Ordering::Relaxed);
}

pub(super) fn field_attempt() {
    FIELD_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    THREAD_RASTER.with(|local| local.borrow_mut().field_raster_attempts += 1);
}
pub(super) fn field_completed() {
    FIELD_COMPLETED.fetch_add(1, Ordering::Release);
    #[cfg(test)]
    THREAD_RASTER.with(|local| local.borrow_mut().field_raster_completed += 1);
}
pub(super) fn role_attempt() {
    ROLE_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    THREAD_RASTER.with(|local| local.borrow_mut().role_raster_attempts += 1);
}
pub(super) fn role_completed() {
    ROLE_COMPLETED.fetch_add(1, Ordering::Release);
    #[cfg(test)]
    THREAD_RASTER.with(|local| local.borrow_mut().role_raster_completed += 1);
}

#[cfg(test)]
#[derive(Clone, Copy, Default)]
pub(super) struct ThreadRaster {
    pub field_raster_attempts: u64,
    pub field_raster_completed: u64,
    pub role_raster_attempts: u64,
    pub role_raster_completed: u64,
}
#[cfg(test)]
thread_local! {static THREAD_RASTER:std::cell::RefCell<ThreadRaster>=std::cell::RefCell::new(ThreadRaster::default());}
#[cfg(test)]
pub(super) fn thread_snapshot() -> ThreadRaster {
    THREAD_RASTER.with(|local| *local.borrow())
}
