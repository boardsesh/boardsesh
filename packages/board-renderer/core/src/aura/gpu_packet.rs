//! Lazy Aura chunks and the sole producer of native descriptor/uniform bytes.
//! Native owns stable arena placement, actual GPU admission and fence pins.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::gpu_atlas::{AtlasSelection, prepare_subset, prepare_subset_checked};
use super::gpu_constants::{
    EDIT_DURATION_MS, EDIT_PEAK_REACH, EDIT_PEAK_TIME_MS, REVEAL_BAND, REVEAL_MODE_SWAP,
    REVEAL_MODE_WIPE,
};
use crate::types::{Color, HoldRenderStyle, RenderConfig};

pub const PACKET_VERSION: u32 = 1;
pub const DESCRIPTOR_BYTES: usize = 224;
pub const UNIFORM_BYTES: usize = 144;
pub const TILE_EDGE: u32 = 32;
pub const LUT_WORDS: usize = 257;
pub use super::gpu_constants::MAX_GPU_BYTES;
pub const MAX_HEADER_BYTES: usize = 256 * 1024;
pub const MAX_FRAME_BYTES: usize = 32 * 1024;
const MAX_CPU_BYTES: usize = 32 * 1024 * 1024;
const NONE: u32 = u32::MAX;
static LIVE_SESSIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
pub struct Cancellation(AtomicBool);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<(), String> {
        if self.0.load(Ordering::Acquire) {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Stamp {
    pub offset: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
impl Stamp {
    fn crop(&self) -> [u32; 4] {
        [self.x, self.y, self.width, self.height]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FieldLayout {
    pub id: u32,
    pub crop: [u32; 4],
    pub bounds: [f32; 4],
    pub reach: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoleLayout {
    pub hold: FieldLayout,
    pub identity: u32,
    pub color: [f32; 3],
    pub annotation: bool,
    pub fills: [Option<Stamp>; 4],
    pub plate: Option<Stamp>,
    pub glyphs: [Option<Stamp>; 2],
}

/// Retained by native residency without retaining a CPU pixel allocation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChunkLayout {
    pub key: String,
    pub bytes: usize,
    pub field: Option<FieldLayout>,
    pub role: Option<RoleLayout>,
    pub covers: Option<Stamp>,
}

struct CachedChunk {
    layout: Arc<ChunkLayout>,
    bytes: Arc<Vec<u8>>,
    used: u64,
    charge: usize,
}
#[derive(Default)]
struct ChunkCache {
    entries: HashMap<String, CachedChunk>,
    bytes: usize,
    clock: u64,
}
impl ChunkCache {
    fn get(&mut self, key: &str) -> Option<(Arc<ChunkLayout>, Arc<Vec<u8>>)> {
        self.clock = self.clock.wrapping_add(1);
        let entry = self.entries.get_mut(key)?;
        entry.used = self.clock;
        Some((entry.layout.clone(), entry.bytes.clone()))
    }
    fn insert(&mut self, layout: Arc<ChunkLayout>, bytes: Arc<Vec<u8>>) {
        // Account for zero-byte role chunks too: their layout/keys/table slots
        // remain real allocations even when they have no stamp pixels.
        let capacity = bytes
            .capacity()
            .saturating_add(std::mem::size_of::<ChunkLayout>())
            .saturating_add(layout.key.capacity())
            .saturating_add(512);
        if capacity > MAX_CPU_BYTES {
            return;
        }
        if let Some(old) = self.entries.remove(&layout.key) {
            self.bytes -= old.charge;
        }
        while self.bytes.saturating_add(capacity) > MAX_CPU_BYTES || self.entries.len() >= 4096 {
            let Some(key) = self
                .entries
                .iter()
                .min_by_key(|(_, chunk)| chunk.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(old) = self.entries.remove(&key) {
                self.bytes -= old.charge;
            }
        }
        self.clock = self.clock.wrapping_add(1);
        self.bytes += capacity;
        self.entries.insert(
            layout.key.clone(),
            CachedChunk {
                layout,
                bytes,
                used: self.clock,
                charge: capacity,
            },
        );
    }
}
static CHUNKS: LazyLock<Mutex<ChunkCache>> = LazyLock::new(|| Mutex::new(ChunkCache::default()));
pub(super) fn cached_for_persistence(key: &str) -> Option<(Arc<ChunkLayout>, Arc<Vec<u8>>)> {
    CHUNKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(key)
}

#[derive(Clone)]
struct CanonicalRole {
    identity: u32,
    annotation: bool,
    color: [f32; 3],
}

pub struct Session {
    config: RenderConfig,
    identity: String,
    geometry_identity: String,
    global: Value,
    roles: HashMap<u32, CanonicalRole>,
    holds: HashMap<u32, usize>,
    fields: HashMap<u32, FieldLayout>,
    cache_directory: Mutex<Option<PathBuf>>,
    dirty: Mutex<BTreeSet<String>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        LIVE_SESSIONS.fetch_sub(1, Ordering::AcqRel);
    }
}
impl Session {
    pub fn from_json(bytes: &[u8], cancelled: &Cancellation) -> Result<Arc<Self>, String> {
        let _work = super::gpu_packet_stats::preparation();
        cancelled.check()?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("config exceeds 8 MiB".into());
        }
        let mut source: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        let original_frames = source["frames"]
            .as_str()
            .ok_or("config frames must be a string")?
            .to_owned();
        source
            .as_object_mut()
            .ok_or("config must be an object")?
            .insert("frames".into(), json!(""));
        let identity = super::gpu_geometry::sha256(
            &serde_json::to_vec(&source).map_err(|error| error.to_string())?,
        );
        let mut config: RenderConfig =
            serde_json::from_value(source).map_err(|error| error.to_string())?;
        config.frames = original_frames;
        // The empty selection validates and computes layout scalars without EDT/stamps.
        let empty = prepare_subset(
            &config,
            None,
            Some(&AtlasSelection {
                describe: true,
                ..Default::default()
            }),
        )?;
        let mut global: Value =
            serde_json::from_slice(&empty.manifest).map_err(|error| error.to_string())?;
        let mut states: Vec<_> = config.hold_state_map.iter().collect();
        states.sort_by_key(|(state, _)| **state);
        let mut visuals = HashMap::new();
        let mut roles = HashMap::new();
        for (&state, appearance) in states {
            let Some(color) = Color::from_hex(&appearance.color) else {
                continue;
            };
            let signature = format!(
                "{:?}:{:?}:{}:{}:{}",
                appearance.role, appearance.render_style, color.r, color.g, color.b
            );
            let canonical = *visuals.entry(signature).or_insert(state);
            roles.insert(
                state,
                CanonicalRole {
                    identity: canonical,
                    annotation: appearance.render_style == HoldRenderStyle::AboveMarker,
                    color: [color.r as f32, color.g as f32, color.b as f32],
                },
            );
        }
        let mut holds = HashMap::new();
        let mut fields = HashMap::new();
        for hold in global["holds"]
            .as_array()
            .ok_or("invalid layout metadata")?
        {
            let id = number(hold, "id")?;
            let index = number(hold, "sourceIndex")? as usize;
            if holds.insert(id, index).is_some() {
                return Err("duplicate physical hold id".into());
            }
            fields.insert(
                id,
                FieldLayout {
                    id,
                    crop: [
                        number(hold, "x")?,
                        number(hold, "y")?,
                        number(hold, "width")?,
                        number(hold, "height")?,
                    ],
                    bounds: serde_json::from_value(hold["bounds"].clone())
                        .map_err(|error| error.to_string())?,
                    reach: hold["reach"].as_f64().ok_or("invalid reach")? as f32,
                },
            );
        }
        global["holds"] = json!([]);
        let geometry_identity = super::gpu_atlas::geometry_cache_key(&config);
        cancelled.check()?;
        #[allow(deprecated)] // Compatible with the pinned Rust 1.98 archive toolchain.
        LIVE_SESSIONS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 8).then_some(count + 1)
            })
            .map_err(|_| "too many live geometry sessions")?;
        Ok(Arc::new(Self {
            geometry_identity,
            config,
            identity,
            global,
            roles,
            holds,
            fields,
            cache_directory: Mutex::new(None),
            dirty: Mutex::new(BTreeSet::new()),
        }))
    }
    fn key(&self, kind: &ChunkKind) -> String {
        let signature = match kind {
            ChunkKind::Field(id) => format!("lazy1:{}:field:{id}", self.geometry_identity),
            ChunkKind::Role(id, state) => format!("lazy1:{}:role:{id}:{state}", self.identity),
            ChunkKind::Covers => format!("lazy1:{}:covers", self.identity),
        };
        super::gpu_geometry::sha256(signature.as_bytes())
    }
    pub fn set_cache_directory(&self, path: PathBuf) -> Result<(), String> {
        if !path.is_absolute()
            || path.as_os_str().as_encoded_bytes().len() > 4096
            || path.file_name().is_none_or(|name| name != "aura-lazy-v1")
        {
            return Err("cache directory must be private aura-lazy-v1".into());
        }
        *self
            .cache_directory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path);
        Ok(())
    }
    pub fn schedule_persist(&self) -> bool {
        let directory = self
            .cache_directory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(directory) = directory else {
            return false;
        };
        let mut dirty = self
            .dirty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let queued = super::gpu_packet_cache::schedule(
            directory,
            self.identity.clone(),
            dirty.iter().cloned().collect(),
        );
        if queued {
            dirty.clear();
        }
        queued
    }
}

#[derive(Clone, Debug)]
enum ChunkKind {
    Field(u32),
    Role(u32, u32),
    Covers,
}
#[derive(Clone)]
struct Selected {
    id: u32,
    identity: u32,
    annotation: bool,
    field: Option<String>,
    role: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRequest {
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub edit_baseline: Option<Vec<[u32; 2]>>,
    #[serde(default = "strict_default")]
    pub strict: bool,
}
fn strict_default() -> bool {
    true
}

pub struct Plan {
    session: Arc<Session>,
    scenes: [Vec<Selected>; 3],
    present: [bool; 3],
    baseline: Option<HashMap<u32, u32>>,
    required: BTreeMap<String, ChunkKind>,
    pub chunks: BTreeMap<String, Arc<ChunkLayout>>,
    pub sources: PreparationSources,
}
#[derive(Clone, Copy, Default, Serialize)]
pub struct PreparationSources {
    pub resident_hits: usize,
    pub cpu_cache_hits: usize,
    pub local_cache_hits: usize,
    pub local_cache_misses: usize,
    pub local_cache_corrupt: usize,
    pub generated_misses: usize,
    pub materialized_pixel_bytes: usize,
}
pub struct MissingChunk {
    pub layout: Arc<ChunkLayout>,
    pub source_offset: usize,
}
pub struct PreparedChunks {
    pub chunks: Vec<MissingChunk>,
    pub bytes: Vec<u8>,
}

impl Plan {
    pub fn new(
        session: Arc<Session>,
        request: SourceRequest,
        cancelled: &Cancellation,
    ) -> Result<Self, String> {
        let _work = super::gpu_packet_stats::preparation();
        cancelled.check()?;
        let present = [true, request.previous.is_some(), request.next.is_some()];
        let mut required = BTreeMap::new();
        let mut scenes: [Vec<Selected>; 3] = Default::default();
        if request
            .edit_baseline
            .as_ref()
            .is_some_and(|baseline| baseline.len() > 128)
        {
            return Err("edit baseline exceeds 128 holds".into());
        }
        for (slot, frames) in [
            Some(request.current.as_ref().unwrap_or(&session.config.frames)),
            request.previous.as_ref(),
            request.next.as_ref(),
        ]
        .into_iter()
        .enumerate()
        {
            let Some(frames) = frames else {
                continue;
            };
            if frames.len() > MAX_FRAME_BYTES {
                return Err("frames exceed 32 KiB".into());
            }
            for token in frames.split(',').next().unwrap_or("").split('p') {
                let mut pieces = token.split('r');
                let Some(id) = pieces.next().and_then(|id| id.parse::<u32>().ok()) else {
                    continue;
                };
                let Some(state) = pieces.next().and_then(|state| state.parse::<u32>().ok()) else {
                    continue;
                };
                if pieces.next().is_some() {
                    continue;
                }
                let Some(role) = session.roles.get(&state) else {
                    if request.strict {
                        return Err("unsupported hold role in frame".into());
                    } else {
                        continue;
                    }
                };
                let Some(&index) = session.holds.get(&id) else {
                    continue;
                };
                let original = &session.config.holds[index];
                let physical = if session.config.mirrored {
                    original
                        .mirrored_hold_id
                        .and_then(|id| session.holds.get(&id))
                        .map(|&index| &session.config.holds[index])
                        .unwrap_or(original)
                } else {
                    original
                };
                if scenes[slot].len() >= 128 {
                    return Err("source exceeds 128 active holds".into());
                }
                let field = (!role.annotation).then(|| session.key(&ChunkKind::Field(physical.id)));
                if let Some(key) = &field {
                    required.insert(key.clone(), ChunkKind::Field(physical.id));
                }
                let key = session.key(&ChunkKind::Role(physical.id, role.identity));
                required.insert(key.clone(), ChunkKind::Role(physical.id, role.identity));
                scenes[slot].push(Selected {
                    id: physical.id,
                    identity: role.identity,
                    annotation: role.annotation,
                    field,
                    role: key,
                });
            }
            if request.strict && !frames.is_empty() && scenes[slot].is_empty() {
                return Err("source contains no matching holds".into());
            }
        }
        // All catalogue covers remain visible even when their holds are unlit.
        if session.config.led_cover.is_some() {
            required.insert(session.key(&ChunkKind::Covers), ChunkKind::Covers);
        }
        let baseline = request
            .edit_baseline
            .map(|rows| rows.into_iter().map(|row| (row[0], row[1])).collect());
        Ok(Self {
            session,
            scenes,
            present,
            baseline,
            required,
            chunks: BTreeMap::new(),
            sources: PreparationSources::default(),
        })
    }
    pub fn describe(&self) -> Value {
        json!({"version":PACKET_VERSION,"contractSha256":contract_sha256(),"tileEdge":TILE_EDGE,"descriptorBytes":DESCRIPTOR_BYTES,"uniformBytes":UNIFORM_BYTES,
            "sessionKey":self.session.identity,"counts":self.scenes.each_ref().map(Vec::len),"present":self.present,
            "chunks":self.required.keys().collect::<Vec<_>>()})
    }

    /// Existing residency is metadata-only. Never regenerate or copy its pixels.
    pub fn prepare(
        &mut self,
        resident: &[Arc<ChunkLayout>],
        cancelled: &Cancellation,
    ) -> Result<PreparedChunks, String> {
        let _work = super::gpu_packet_stats::preparation();
        cancelled.check()?;
        let mut ready = BTreeMap::new();
        let mut sources = PreparationSources::default();
        for layout in resident {
            if !self.required.contains_key(&layout.key)
                || ready.insert(layout.key.clone(), layout.clone()).is_some()
            {
                return Err("foreign or duplicate resident chunk".into());
            }
            sources.resident_hits += 1;
        }
        let mut payloads = BTreeMap::new();
        let mut uncached = BTreeMap::new();
        for (key, kind) in &self.required {
            cancelled.check()?;
            if ready.contains_key(key) {
                continue;
            }
            let cached = CHUNKS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(key);
            if let Some((layout, bytes)) = cached {
                super::gpu_packet_stats::cpu_hit();
                sources.cpu_cache_hits += 1;
                payloads.insert(key.clone(), (layout, bytes));
            } else {
                let directory = self
                    .session
                    .cache_directory
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                let cached = directory.map(|directory| {
                    super::gpu_packet_cache::read(
                        &directory,
                        &self.session.identity,
                        key,
                        |layout| self.valid_layout(kind, layout),
                    )
                });
                match cached {
                    Some(super::gpu_packet_cache::ReadResult::Hit(layout, bytes))
                        if self.valid_layout(kind, &layout) =>
                    {
                        sources.local_cache_hits += 1;
                        super::gpu_packet_stats::local_hit();
                        payloads.insert(key.clone(), (layout, Arc::new(bytes)));
                    }
                    Some(
                        super::gpu_packet_cache::ReadResult::Hit(..)
                        | super::gpu_packet_cache::ReadResult::Corrupt,
                    ) => {
                        sources.local_cache_corrupt += 1;
                        super::gpu_packet_stats::local_corrupt();
                        uncached.insert(key.clone(), kind.clone());
                    }
                    Some(super::gpu_packet_cache::ReadResult::Missing) => {
                        sources.local_cache_misses += 1;
                        super::gpu_packet_stats::local_miss();
                        uncached.insert(key.clone(), kind.clone());
                    }
                    None => {
                        uncached.insert(key.clone(), kind.clone());
                    }
                }
            }
        }
        if !uncached.is_empty() {
            sources.generated_misses = uncached.len();
            cancelled.check()?;
            let mut selection = AtlasSelection::default();
            for kind in uncached.values() {
                match kind {
                    ChunkKind::Field(id) => {
                        selection.fields.insert(*id);
                    }
                    ChunkKind::Role(id, state) => {
                        selection.roles.entry(*id).or_default().insert(*state);
                    }
                    ChunkKind::Covers => selection.covers = true,
                }
            }
            let prepared =
                prepare_subset_checked(&self.session.config, None, Some(&selection), &|| {
                    cancelled.check()
                })?;
            cancelled.check()?;
            let manifest: Value =
                serde_json::from_slice(&prepared.manifest).map_err(|error| error.to_string())?;
            for (key, kind) in &uncached {
                cancelled.check()?;
                let (layout, bytes) = extract_chunk(key, kind, &manifest, &prepared.pixels)?;
                payloads.insert(key.clone(), (Arc::new(layout), Arc::new(bytes)));
            }
        }
        let mut bytes = Vec::new();
        let mut chunks = Vec::new();
        for (key, (layout, payload)) in &payloads {
            cancelled.check()?;
            if bytes
                .len()
                .checked_add(payload.len())
                .is_none_or(|size| size > MAX_GPU_BYTES)
            {
                return Err("missing chunks exceed 128 MiB".into());
            }
            chunks.push(MissingChunk {
                layout: layout.clone(),
                source_offset: bytes.len(),
            });
            bytes.extend_from_slice(payload);
            ready.insert(key.clone(), layout.clone());
        }
        cancelled.check()?;
        // Publish cache updates only after the entire cancellable batch succeeds.
        {
            let mut cache = CHUNKS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for (layout, payload) in payloads.values() {
                cache.insert(layout.clone(), payload.clone());
            }
        }
        self.chunks = ready;
        sources.materialized_pixel_bytes = bytes.len();
        self.sources = sources;
        self.session
            .dirty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend(payloads.keys().cloned());
        Ok(PreparedChunks { chunks, bytes })
    }
    fn valid_layout(&self, kind: &ChunkKind, layout: &ChunkLayout) -> bool {
        if layout.key != self.session.key(kind)
            || layout.bytes > MAX_GPU_BYTES
            || !layout.bytes.is_multiple_of(4)
        {
            return false;
        }
        let width = number(&self.session.global, "width").unwrap_or(0);
        let height = number(&self.session.global, "height").unwrap_or(0);
        let crop_ok = |crop: [u32; 4]| {
            crop[2] > 0
                && crop[3] > 0
                && crop[0]
                    .checked_add(crop[2])
                    .is_some_and(|right| right <= width)
                && crop[1]
                    .checked_add(crop[3])
                    .is_some_and(|bottom| bottom <= height)
        };
        let field_ok = |field: &FieldLayout| {
            crop_ok(field.crop)
                && field.bounds.iter().all(|number| number.is_finite())
                && field.reach.is_finite()
                && (0.0..=512.0).contains(&field.reach)
        };
        let stamp_ok = |stamp: &Option<Stamp>| {
            stamp.as_ref().is_none_or(|stamp| {
                crop_ok(stamp.crop())
                    && stamp.offset % 4 == 0
                    && (stamp.width as usize)
                        .checked_mul(stamp.height as usize)
                        .and_then(|size| size.checked_mul(4))
                        .and_then(|size| size.checked_add(stamp.offset as usize))
                        .is_some_and(|end| end <= layout.bytes)
            })
        };
        match kind {
            ChunkKind::Field(id) => {
                layout.role.is_none()
                    && layout.covers.is_none()
                    && layout.field.as_ref().is_some_and(|field| {
                        field.id == *id
                            && self.session.fields.get(id) == Some(field)
                            && field_ok(field)
                            && (field.crop[2] as usize) * (field.crop[3] as usize) * 4
                                == layout.bytes
                    })
            }
            ChunkKind::Role(id, state) => {
                layout.field.is_none()
                    && layout.covers.is_none()
                    && layout.role.as_ref().is_some_and(|role| {
                        role.identity == *state
                            && self.session.fields.get(id) == Some(&role.hold)
                            && role.hold.id == *id
                            && field_ok(&role.hold)
                            && self.session.roles.get(state).is_some_and(|state| {
                                state.annotation == role.annotation && state.color == role.color
                            })
                            && role
                                .color
                                .iter()
                                .all(|color| color.is_finite() && (0.0..=255.0).contains(color))
                            && role
                                .fills
                                .iter()
                                .chain(role.glyphs.iter())
                                .chain(std::iter::once(&role.plate))
                                .all(stamp_ok)
                    })
            }
            ChunkKind::Covers => {
                layout.field.is_none() && layout.role.is_none() && stamp_ok(&layout.covers)
            }
        }
    }
}

fn extract_chunk(
    key: &str,
    kind: &ChunkKind,
    manifest: &Value,
    pixels: &[u8],
) -> Result<(ChunkLayout, Vec<u8>), String> {
    let mut layout = ChunkLayout {
        key: key.into(),
        bytes: 0,
        field: None,
        role: None,
        covers: None,
    };
    let mut begin = usize::MAX;
    let mut end = 0;
    fn include(stamp: &Option<Stamp>, begin: &mut usize, end: &mut usize) -> Result<(), String> {
        if let Some(stamp) = stamp {
            let length = (stamp.width as usize)
                .checked_mul(stamp.height as usize)
                .and_then(|size| size.checked_mul(4))
                .ok_or("stamp size overflow")?;
            *begin = (*begin).min(stamp.offset as usize);
            *end = (*end).max(
                (stamp.offset as usize)
                    .checked_add(length)
                    .ok_or("stamp range overflow")?,
            );
        }
        Ok(())
    }
    let parse_stamp = |stamp: &Value| -> Result<Option<Stamp>, String> {
        serde_json::from_value(stamp.clone()).map_err(|error| error.to_string())
    };
    match kind {
        ChunkKind::Covers => {
            layout.covers = parse_stamp(&manifest["covers"])?;
            include(&layout.covers, &mut begin, &mut end)?;
        }
        ChunkKind::Field(id) | ChunkKind::Role(id, _) => {
            let hold = manifest["holds"]
                .as_array()
                .and_then(|holds| {
                    holds
                        .iter()
                        .find(|hold| hold["id"].as_u64() == Some(*id as u64))
                })
                .ok_or("missing prepared hold")?;
            if matches!(kind, ChunkKind::Field(_)) {
                let crop = [
                    number(hold, "x")?,
                    number(hold, "y")?,
                    number(hold, "width")?,
                    number(hold, "height")?,
                ];
                let length = (crop[2] as usize)
                    .checked_mul(crop[3] as usize)
                    .and_then(|size| size.checked_mul(4))
                    .ok_or("field size overflow")?;
                begin = number(hold, "field")? as usize;
                end = begin.checked_add(length).ok_or("field range overflow")?;
                layout.field = Some(FieldLayout {
                    id: *id,
                    crop,
                    bounds: serde_json::from_value(hold["bounds"].clone())
                        .map_err(|error| error.to_string())?,
                    reach: hold["reach"].as_f64().ok_or("invalid reach")? as f32,
                });
            } else if let ChunkKind::Role(_, state) = kind {
                let role = hold["roles"]
                    .as_array()
                    .and_then(|roles| {
                        roles
                            .iter()
                            .find(|role| role["state"].as_u64() == Some(*state as u64))
                    })
                    .ok_or("missing prepared role")?;
                let fills: [Option<Stamp>; 4] = serde_json::from_value(role["fillPasses"].clone())
                    .map_err(|error| error.to_string())?;
                let glyphs: [Option<Stamp>; 2] =
                    serde_json::from_value(role["glyphPasses"].clone())
                        .map_err(|error| error.to_string())?;
                let plate = parse_stamp(&role["plate"])?;
                for stamp in fills
                    .iter()
                    .chain(glyphs.iter())
                    .chain(std::iter::once(&plate))
                {
                    include(stamp, &mut begin, &mut end)?;
                }
                layout.role = Some(RoleLayout {
                    hold: FieldLayout {
                        id: *id,
                        crop: [
                            number(hold, "x")?,
                            number(hold, "y")?,
                            number(hold, "width")?,
                            number(hold, "height")?,
                        ],
                        bounds: serde_json::from_value(hold["bounds"].clone())
                            .map_err(|error| error.to_string())?,
                        reach: hold["reach"].as_f64().ok_or("invalid reach")? as f32,
                    },
                    identity: *state,
                    color: serde_json::from_value(role["color"].clone())
                        .map_err(|error| error.to_string())?,
                    annotation: role["annotation"].as_bool().unwrap_or(false),
                    fills,
                    plate,
                    glyphs,
                });
            }
        }
    }
    if begin == usize::MAX {
        begin = 0;
    }
    let bytes = pixels
        .get(begin..end)
        .ok_or("chunk range outside prepared bytes")?
        .to_vec();
    let rebase = |stamp: &mut Option<Stamp>| {
        if let Some(stamp) = stamp {
            stamp.offset -= begin as u32;
        }
    };
    rebase(&mut layout.covers);
    if let Some(role) = &mut layout.role {
        for stamp in role
            .fills
            .iter_mut()
            .chain(role.glyphs.iter_mut())
            .chain(std::iter::once(&mut role.plate))
        {
            rebase(stamp);
        }
    }
    layout.bytes = bytes.len();
    Ok((layout, bytes))
}
fn number(object: &Value, name: &str) -> Result<u32, String> {
    object[name]
        .as_u64()
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| format!("invalid {name}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub key: String,
    pub offset: u32,
    pub bytes: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placements {
    pub arena_bytes: u32,
    pub chunks: Vec<Placement>,
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct SceneInfo {
    pub offset: usize,
    pub bytes: usize,
    pub count: usize,
    pub max_reach: f32,
    pub stamp_layers: u32,
    pub tile_directory: u32,
}
pub struct Packet {
    session: Arc<Session>,
    pub scenes: [SceneInfo; 3],
    pub present: [bool; 3],
    pub descriptors: Vec<u8>,
    pub resources: Vec<u8>,
    covers: Option<Stamp>,
    current_roles: Vec<[u32; 2]>,
    changed_count: usize,
    sources: PreparationSources,
    // Keep checked immutable layouts alive independently of registry closes.
    _chunks: Vec<Arc<ChunkLayout>>,
}

impl Plan {
    pub fn encode(
        &self,
        placements: Placements,
        cancelled: &Cancellation,
    ) -> Result<Packet, String> {
        let _work = super::gpu_packet_stats::preparation();
        cancelled.check()?;
        if placements.arena_bytes as usize > MAX_GPU_BYTES
            || placements.chunks.len() != self.required.len()
            || self.chunks.len() != self.required.len()
        {
            return Err("incomplete or oversized chunk placements".into());
        }
        let mut offsets = BTreeMap::new();
        let mut ranges = Vec::new();
        for placement in placements.chunks {
            let layout = self
                .chunks
                .get(&placement.key)
                .ok_or("foreign chunk placement")?;
            let end = placement
                .offset
                .checked_add(placement.bytes)
                .ok_or("placement range overflow")?;
            if placement.offset % 4 != 0
                || placement.bytes as usize != layout.bytes
                || end > placements.arena_bytes
                || offsets.insert(placement.key, placement.offset).is_some()
            {
                return Err("invalid or duplicate arena placement".into());
            }
            if placement.bytes > 0 {
                ranges.push((placement.offset, end));
            }
        }
        ranges.sort_unstable();
        if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
            return Err("overlapping arena chunks".into());
        }
        let mut resources = Vec::new();
        let lut: Vec<f32> = serde_json::from_value(self.session.global["lut"].clone())
            .map_err(|error| error.to_string())?;
        if lut.len() != LUT_WORDS {
            return Err("invalid falloff LUT".into());
        }
        for entry in lut {
            put_float(&mut resources, entry);
        }
        let width = number(&self.session.global, "width")?;
        let height = number(&self.session.global, "height")?;
        let columns = width.div_ceil(TILE_EDGE);
        let rows = height.div_ceil(TILE_EDGE);
        let tiles = (columns as usize)
            .checked_mul(rows as usize)
            .ok_or("tile count overflow")?;
        let mut descriptors = Vec::new();
        let mut scenes = [SceneInfo::default(); 3];
        let roles: [HashMap<u32, u32>; 3] = self.scenes.each_ref().map(|scene| {
            scene
                .iter()
                .map(|selected| (selected.id, selected.identity))
                .collect()
        });
        for (slot, scene) in self.scenes.iter().enumerate() {
            cancelled.check()?;
            let descriptor_start = descriptors.len();
            let mut tile_lists = vec![Vec::new(); tiles];
            let mut max_reach = 0_f32;
            let mut layers = 0;
            for (ordinal, selected) in scene.iter().enumerate() {
                cancelled.check()?;
                let role_chunk = &self.chunks[&selected.role];
                let role = role_chunk
                    .role
                    .as_ref()
                    .ok_or("role chunk metadata missing")?;
                if role.identity != selected.identity
                    || role.hold.id != selected.id
                    || role.annotation != selected.annotation
                {
                    return Err("role chunk identity mismatch".into());
                }
                let field = selected
                    .field
                    .as_ref()
                    .map(|key| {
                        self.chunks[key]
                            .field
                            .as_ref()
                            .ok_or("field metadata missing")
                    })
                    .transpose()?;
                let hold = field.unwrap_or(&role.hold);
                let field_offset = selected.field.as_ref().map(|key| offsets[key]).unwrap_or(0);
                if !selected.annotation {
                    max_reach = max_reach.max(hold.reach);
                }
                let role_offset = offsets[&selected.role];
                let fills = role
                    .fills
                    .each_ref()
                    .map(|stamp| relocated(stamp, role_offset))
                    .into_iter()
                    .collect::<Result<Vec<_>, _>>()?;
                let glyphs = role
                    .glyphs
                    .each_ref()
                    .map(|stamp| relocated(stamp, role_offset))
                    .into_iter()
                    .collect::<Result<Vec<_>, _>>()?;
                let plate = relocated(&role.plate, role_offset)?;
                let has_fill = fills.iter().any(Option::is_some);
                let has_glyph = glyphs.iter().any(Option::is_some);
                layers |= if role.annotation {
                    if has_glyph { 8 } else { 0 }
                } else {
                    u32::from(has_fill)
                        | (u32::from(plate.is_some()) << 1)
                        | (u32::from(has_glyph) << 2)
                };
                for color in role.color {
                    put_float(&mut descriptors, color / 255.0);
                }
                put_float(&mut descriptors, 1.0);
                for bound in hold.bounds {
                    put_float(&mut descriptors, bound);
                }
                for coordinate in hold.crop {
                    put_uint(&mut descriptors, coordinate);
                }
                for offset in [
                    field_offset,
                    stamp_offset(&fills[0]),
                    stamp_offset(&plate),
                    stamp_offset(&glyphs[0]),
                ] {
                    put_uint(&mut descriptors, offset);
                }
                let (lower, upper) = match slot {
                    0 => (&roles[1], &roles[2]),
                    1 => (&*EMPTY_ROLES, &roles[0]),
                    _ => (&roles[0], &*EMPTY_ROLES),
                };
                let membership = |other: &HashMap<u32, u32>| {
                    other
                        .get(&selected.id)
                        .map(|identity| {
                            if *identity == selected.identity {
                                1.0
                            } else {
                                2.0
                            }
                        })
                        .unwrap_or(0.0)
                };
                let changed = slot == 0
                    && self.baseline.as_ref().is_some_and(|baseline| {
                        baseline.get(&selected.id) != Some(&selected.identity)
                    });
                for number in [
                    hold.reach,
                    if changed { 1.0 } else { 0.0 },
                    membership(lower),
                    membership(upper),
                ] {
                    put_float(&mut descriptors, number);
                }
                for identity in [
                    selected.id,
                    selected.identity,
                    u32::from(role.annotation),
                    0,
                ] {
                    put_uint(&mut descriptors, identity);
                }
                for stamp in [&fills[0], &plate, &glyphs[0]] {
                    put_crop(&mut descriptors, stamp);
                }
                for stamp in [&fills[1], &fills[2], &fills[3], &glyphs[1]] {
                    put_uint(&mut descriptors, stamp_offset(stamp));
                }
                for stamp in [&fills[1], &fills[2], &fills[3], &glyphs[1]] {
                    put_crop(&mut descriptors, stamp);
                }
                let mut crops: Vec<_> = fills
                    .iter()
                    .chain(glyphs.iter())
                    .chain(std::iter::once(&plate))
                    .filter_map(|stamp| stamp.as_ref().map(Stamp::crop))
                    .collect();
                if !selected.annotation {
                    crops.push(hold.crop);
                }
                // Append each ordinal once, in original descriptor order.
                let mut covered = vec![false; tiles];
                for crop in crops {
                    let right = crop[0].checked_add(crop[2]).ok_or("tile crop overflow")?;
                    let bottom = crop[1].checked_add(crop[3]).ok_or("tile crop overflow")?;
                    if right > width || bottom > height {
                        return Err("tile crop outside board".into());
                    }
                    for row in crop[1] / TILE_EDGE..bottom.div_ceil(TILE_EDGE) {
                        for column in crop[0] / TILE_EDGE..right.div_ceil(TILE_EDGE) {
                            covered[(row * columns + column) as usize] = true;
                        }
                    }
                }
                for (tile, covered) in covered.into_iter().enumerate() {
                    if covered {
                        tile_lists[tile].push(ordinal as u32);
                    }
                }
            }
            if scene.is_empty() {
                descriptors.resize(descriptors.len() + DESCRIPTOR_BYTES, 0);
            }
            let directory = resources.len() / 4;
            resources.resize(resources.len() + tiles * 8, 0);
            for (tile, indices) in tile_lists.iter().enumerate() {
                cancelled.check()?;
                let first =
                    u32::try_from(resources.len() / 4).map_err(|_| "tile offset overflow")?;
                let position = directory * 4 + tile * 8;
                resources[position..position + 4].copy_from_slice(&first.to_le_bytes());
                resources[position + 4..position + 8]
                    .copy_from_slice(&(indices.len() as u32).to_le_bytes());
                for ordinal in indices {
                    put_uint(&mut resources, *ordinal);
                }
                if resources.len() > 8 * 1024 * 1024 {
                    return Err("tile resources exceed 8 MiB".into());
                }
            }
            scenes[slot] = SceneInfo {
                offset: descriptor_start,
                bytes: descriptors.len() - descriptor_start,
                count: scene.len(),
                max_reach,
                stamp_layers: layers,
                tile_directory: directory as u32,
            };
        }
        let covers = self
            .required
            .iter()
            .find(|(_, kind)| matches!(kind, ChunkKind::Covers))
            .map(|(key, _)| relocated(&self.chunks[key].covers, offsets[key]))
            .transpose()?
            .flatten();
        let current_roles = roles[0]
            .iter()
            .map(|(&id, &identity)| (id, identity))
            .collect::<BTreeMap<_, _>>()
            .into_iter()
            .map(|(id, identity)| [id, identity])
            .collect();
        let changed_count = self.scenes[0]
            .iter()
            .filter(|selected| {
                self.baseline
                    .as_ref()
                    .is_some_and(|baseline| baseline.get(&selected.id) != Some(&selected.identity))
            })
            .count();
        Ok(Packet {
            session: self.session.clone(),
            scenes,
            present: self.present,
            descriptors,
            resources,
            covers,
            current_roles,
            changed_count,
            sources: self.sources,
            _chunks: self.chunks.values().cloned().collect(),
        })
    }
}
static EMPTY_ROLES: LazyLock<HashMap<u32, u32>> = LazyLock::new(HashMap::new);

fn relocated(stamp: &Option<Stamp>, base: u32) -> Result<Option<Stamp>, String> {
    stamp
        .as_ref()
        .map(|stamp| {
            let mut stamp = stamp.clone();
            stamp.offset = stamp
                .offset
                .checked_add(base)
                .ok_or("stamp placement overflow")?;
            Ok(stamp)
        })
        .transpose()
}
fn stamp_offset(stamp: &Option<Stamp>) -> u32 {
    stamp.as_ref().map(|stamp| stamp.offset).unwrap_or(NONE)
}
fn put_crop(bytes: &mut Vec<u8>, stamp: &Option<Stamp>) {
    for coordinate in stamp.as_ref().map(Stamp::crop).unwrap_or([0; 4]) {
        put_uint(bytes, coordinate);
    }
}
fn put_uint(bytes: &mut Vec<u8>, number: u32) {
    bytes.extend_from_slice(&number.to_le_bytes());
}
fn put_float(bytes: &mut Vec<u8>, number: f32) {
    bytes.extend_from_slice(&number.to_le_bytes());
}

/// What a player frame shows between its lower and upper scene.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reveal {
    /// A soft band sweeps across the wall: 0 shows the lower scene, 1 the upper.
    Wipe { progress: f32 },
    /// The wall swap. Holds lit only in the lower scene (or a changed hold's
    /// lower role) take `lower`, those only in the upper scene take `upper`, and
    /// holds lit with the same role in both take `shared`, drawn once. Position
    /// plays no part. A `shared` of 1 keeps shared holds fully lit, as native
    /// API 6 drew them; the app decides how far they dip.
    Swap { lower: f32, upper: f32, shared: f32 },
}
impl Reveal {
    /// The flat native arguments: `mode` is `REVEAL_MODE_WIPE` or `REVEAL_MODE_SWAP`.
    pub fn from_native(
        mode: u32,
        progress: f32,
        lower: f32,
        upper: f32,
        shared: f32,
    ) -> Result<Self, String> {
        let reveal = match mode {
            REVEAL_MODE_WIPE => Self::Wipe { progress },
            REVEAL_MODE_SWAP => Self::Swap {
                lower,
                upper,
                shared,
            },
            _ => return Err("invalid dynamic uniform input".into()),
        };
        if reveal.is_valid() {
            Ok(reveal)
        } else {
            Err("invalid dynamic uniform input".into())
        }
    }
    fn is_valid(&self) -> bool {
        let unit = |number: f32| number.is_finite() && (0.0..=1.0).contains(&number);
        match *self {
            Self::Wipe { progress } => unit(progress),
            Self::Swap {
                lower,
                upper,
                shared,
            } => unit(lower) && unit(upper) && unit(shared),
        }
    }
    /// The shader's `motion.x`. It picks the still compositor at 0 (lower) and 1
    /// (upper), the stamp layers, and how much veil an empty side keeps. The
    /// still compositor draws every hold whole, so a swap reaches 0 or 1 only
    /// when one side is fully lit, the other fully gone and shared holds fully
    /// lit. An empty side's veil follows the other side's weight.
    pub fn progress(&self, same_scene: bool, lower_count: usize, upper_count: usize) -> f32 {
        match *self {
            Self::Wipe { progress } => progress,
            Self::Swap { .. } if same_scene => 0.0,
            Self::Swap {
                lower,
                upper,
                shared,
            } => match (lower_count > 0, upper_count > 0) {
                // With one side empty no hold is in both climbs: `shared`
                // weights nothing.
                (true, false) => 1.0 - lower,
                (false, true) => upper,
                _ if shared < 1.0 => {
                    // Dimmed shared holds need the weighted compositor. With both
                    // sides lit the veil is whole at any interior value, so this
                    // only selects it.
                    ((1.0 - lower + upper) * 0.5).clamp(f32::EPSILON, 1.0 - f32::EPSILON)
                }
                _ => (1.0 - lower + upper) * 0.5,
            },
        }
    }
    /// Uniform `tuning2.w` (word 15, byte 60): the shared same-role hold weight.
    /// Only the weighted swap compositor reads it, so every other frame (the
    /// wipe, and any frame that selects a still) leaves the word zero, exactly
    /// as native API 6 did.
    fn shared_weight_bits(&self, progress: f32) -> u32 {
        match *self {
            Self::Swap { shared, .. } if progress > 0.0 && progress < 1.0 => shared.to_bits(),
            _ => 0,
        }
    }
}

impl Packet {
    pub fn describe(&self) -> Value {
        let prepare_source = if self.sources.generated_misses > 0 {
            "generated"
        } else if self.sources.local_cache_hits > 0 {
            "local-cache"
        } else if self.sources.cpu_cache_hits > 0 {
            "cpu-cache"
        } else {
            "resident"
        };
        json!({"version":PACKET_VERSION,"contractSha256":contract_sha256(),"width":self.session.global["width"],"height":self.session.global["height"],
            "scenes":self.scenes,"present":self.present,"current_roles":self.current_roles,"changed_count":self.changed_count,"descriptorBytes":DESCRIPTOR_BYTES,"uniformBytes":UNIFORM_BYTES,
            "preparation_sources":self.sources,"prepareSource":prepare_source,"localCacheHit":self.sources.local_cache_hits>0,
            "tileEdge":TILE_EDGE,"columns":number(&self.session.global,"width").unwrap_or(0).div_ceil(TILE_EDGE),
            "descriptorPayloadBytes":self.descriptors.len(),"resourceBytes":self.resources.len()})
    }
    #[allow(clippy::too_many_arguments)] // Mirrors the flat allocation-free native ABI.
    pub fn encode_uniforms(
        &self,
        lower: usize,
        upper: usize,
        reveal: Reveal,
        pulse: f32,
        viewport: [f32; 2],
        production_empty: bool,
        mirrored: bool,
        output: &mut [u8; UNIFORM_BYTES],
    ) -> Result<(), String> {
        if lower >= 3
            || upper >= 3
            || !self.present[lower]
            || !self.present[upper]
            || !reveal.is_valid()
            || !pulse.is_finite()
            || !(1.0..=EDIT_PEAK_REACH).contains(&pulse)
            || viewport
                .iter()
                .any(|number| !number.is_finite() || *number <= 0.0 || *number > 16384.0)
        {
            return Err("invalid dynamic uniform input".into());
        }
        let progress = reveal.progress(
            lower == upper,
            self.scenes[lower].count,
            self.scenes[upper].count,
        );
        let lower = self.scenes[lower];
        let upper = self.scenes[upper];
        let mut words = [0_u32; 36];
        let scalar = |name: &str| self.session.global[name].as_f64().unwrap_or(0.0) as f32;
        let width = number(&self.session.global, "width")? as f32;
        let height = number(&self.session.global, "height")? as f32;
        for (index, number) in [
            width,
            height,
            lower.count as f32,
            if self.session.global["glow"].as_bool().unwrap_or(false) {
                1.0
            } else {
                0.0
            },
        ]
        .into_iter()
        .enumerate()
        {
            words[index] = number.to_bits();
        }
        let veil = self.session.global["veil"]
            .as_array()
            .ok_or("invalid veil")?;
        if veil.len() != 4 {
            return Err("invalid veil".into());
        }
        for (index, number) in veil.iter().enumerate() {
            words[4 + index] =
                ((number.as_f64().ok_or("invalid veil channel")? as f32) / 255.0).to_bits();
        }
        for (index, name) in [
            "merge",
            "seam",
            "seamMix",
            "seamSharpness",
            "fringe",
            "coreShare",
        ]
        .into_iter()
        .enumerate()
        {
            words[8 + index] = scalar(name).to_bits();
        }
        words[14] = lower.max_reach.to_bits();
        words[15] = reveal.shared_weight_bits(progress);
        words[16] = self
            .covers
            .as_ref()
            .map(|stamp| stamp.offset)
            .unwrap_or(NONE);
        words[17] = if progress <= 0.0 {
            lower.stamp_layers
        } else if progress >= 1.0 {
            upper.stamp_layers
        } else {
            lower.stamp_layers | upper.stamp_layers
        };
        words[18] = lower.tile_directory;
        words[19] = upper.tile_directory;
        words[20] = viewport[0].to_bits();
        words[21] = viewport[1].to_bits();
        // The wipe leaves the swap slots zero, so its bytes match earlier builds.
        if let Reveal::Swap {
            lower: lower_weight,
            upper: upper_weight,
            ..
        } = reveal
        {
            words[22] = lower_weight.to_bits();
            words[23] = upper_weight.to_bits();
            words[26] = (REVEAL_MODE_SWAP as f32).to_bits();
        }
        words[24] = progress.to_bits();
        words[25] = REVEAL_BAND.to_bits();
        words[27] = pulse.to_bits();
        words[28] = (upper.count as f32).to_bits();
        words[29] = upper.max_reach.to_bits();
        words[30] = (if production_empty { 1_f32 } else { 0_f32 }).to_bits();
        words[31] = (if mirrored { 1_f32 } else { 0_f32 }).to_bits();
        for (index, coordinate) in self
            .covers
            .as_ref()
            .map(Stamp::crop)
            .unwrap_or([0; 4])
            .into_iter()
            .enumerate()
        {
            words[32 + index] = coordinate;
        }
        for (word, target) in words.into_iter().zip(output.as_chunks_mut::<4>().0) {
            target.copy_from_slice(&word.to_le_bytes());
        }
        Ok(())
    }
}

pub fn contract_manifest() -> Value {
    json!({"packetVersion":PACKET_VERSION,"nativeApiVersion":7,"statsVersion":1,"descriptorBytes":DESCRIPTOR_BYTES,"uniformBytes":UNIFORM_BYTES,
        "editDurationMs":EDIT_DURATION_MS,"editPeakTimeMs":EDIT_PEAK_TIME_MS,"editPeakReachBits":EDIT_PEAK_REACH.to_bits(),"revealBandBits":REVEAL_BAND.to_bits(),
        "revealModeWipe":REVEAL_MODE_WIPE,"revealModeSwap":REVEAL_MODE_SWAP,
        "tileEdge":TILE_EDGE,"lutWords":LUT_WORDS,"maxGpuBytes":MAX_GPU_BYTES,"maxActivePerSource":128,
        "metalBindings":{"pixels":0,"lower":1,"uniforms":2,"resources":3,"upper":4},
        "glesStorageBindings":{"pixels":0,"lower":1,"upper":2,"resources":3},"glesUniformBindings":{"uniforms":0},
        "statuses":{"success":0,"invalid":-1,"unsupported":-2,"cancelled":-3,"closed":-4,"resourcePressure":-5,"internalPanic":-6},
        "descriptorOffsets":{"color":0,"bounds":16,"crop":32,"offsets":48,"numbers":64,"identity":80,"fillCrop":96,"plateCrop":112,"glyphCrop":128,"extraOffsets":144,"fillCrop1":160,"fillCrop2":176,"fillCrop3":192,"glyphCrop1":208},
        "uniformOffsets":{"size":0,"veil":16,"tuning":32,"tuning2":48,"sharedWeight":60,"offsets":64,"viewport":80,"swapWeights":88,"motion":96,"other":112,"coverCrop":128}})
}
pub fn contract_sha256() -> &'static str {
    static HASH: LazyLock<String> = LazyLock::new(|| {
        super::gpu_geometry::sha256(
            &serde_json::to_vec(&contract_manifest()).expect("finite contract constants"),
        )
    });
    &HASH
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    #[test]
    fn generated_contract_manifest_matches_the_production_encoder() {
        let emitted: Value =
            serde_json::from_str(include_str!("../../gpu-packet-v1.json")).unwrap();
        assert_eq!(emitted, contract_manifest());
    }
    fn fixture() -> Value {
        json!({"board_width":100,"board_height":100,"output_width":100,"frames":"p1r42",
            "thumbnail":false,"render_mode":"aura","mark_style":"outline","glyphs":"role",
            "holds":[{"id":1,"cx":25,"cy":55,"r":8,"mirroredHoldId":2},{"id":2,"cx":75,"cy":55,"r":16,"mirroredHoldId":1},
                {"id":3,"cx":50,"cy":20,"r":4}],
            "hold_state_map":{"13":{"color":"#00FF00","role":"hand"},"42":{"color":"#00FF00","role":"hand"},
                "44":{"color":"#FF0000","role":"finish"},"46":{"color":"#FFFF00","render_style":"above-marker"}}})
    }
    fn session() -> Arc<Session> {
        Session::from_json(
            &serde_json::to_vec(&fixture()).unwrap(),
            &Cancellation::default(),
        )
        .unwrap()
    }
    fn request(current: &str, previous: Option<&str>, next: Option<&str>) -> SourceRequest {
        SourceRequest {
            current: Some(current.into()),
            previous: previous.map(str::to_owned),
            next: next.map(str::to_owned),
            edit_baseline: None,
            strict: true,
        }
    }
    fn word(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }
    fn placements(plan: &Plan) -> Placements {
        let mut cursor = 0;
        let chunks = plan
            .chunks
            .iter()
            .map(|(key, chunk)| {
                let placement = Placement {
                    key: key.clone(),
                    offset: cursor,
                    bytes: chunk.bytes as u32,
                };
                cursor += chunk.bytes as u32;
                placement
            })
            .collect();
        Placements {
            arena_bytes: cursor,
            chunks,
        }
    }
    #[test]
    fn lazy_regions_match_full_atlas_without_preparing_unlit_holds_or_aliases() {
        let _serial = TEST_LOCK.lock().unwrap();
        CHUNKS.lock().unwrap().entries.clear();
        CHUNKS.lock().unwrap().bytes = 0;
        let session = session();
        assert!(session.global["holds"].as_array().unwrap().is_empty());
        let mut plan = Plan::new(
            session,
            request("p1r42", None, None),
            &Cancellation::default(),
        )
        .unwrap();
        let prepared = plan.prepare(&[], &Cancellation::default()).unwrap();
        assert_eq!(
            prepared.chunks.len(),
            2,
            "only one field and one canonical role are materialized"
        );
        let full =
            super::super::gpu_atlas::prepare_owned(&serde_json::from_value(fixture()).unwrap())
                .unwrap();
        let manifest: Value = serde_json::from_slice(&full.manifest).unwrap();
        let hold = &manifest["holds"][0];
        for chunk in &prepared.chunks {
            let begin = chunk.source_offset;
            let actual = &prepared.bytes[begin..begin + chunk.layout.bytes];
            if let Some(field) = &chunk.layout.field {
                assert_eq!(
                    field.crop,
                    [
                        number(hold, "x").unwrap(),
                        number(hold, "y").unwrap(),
                        number(hold, "width").unwrap(),
                        number(hold, "height").unwrap()
                    ]
                );
                let offset = number(hold, "field").unwrap() as usize;
                assert_eq!(actual, &full.pixels[offset..offset + actual.len()]);
            }
            if let Some(role) = &chunk.layout.role {
                assert_eq!(
                    role.identity, 13,
                    "alias keeps earlier canonical visual identity"
                );
                let reference = &hold["roles"][0];
                for (stamp, old) in role
                    .fills
                    .iter()
                    .zip(reference["fillPasses"].as_array().unwrap())
                    .chain(
                        role.glyphs
                            .iter()
                            .zip(reference["glyphPasses"].as_array().unwrap()),
                    )
                {
                    if let Some(stamp) = stamp {
                        let length = (stamp.width * stamp.height * 4) as usize;
                        let offset = number(old, "offset").unwrap() as usize;
                        assert_eq!(
                            &actual[stamp.offset as usize..stamp.offset as usize + length],
                            &full.pixels[offset..offset + length]
                        );
                    } else {
                        assert!(old.is_null());
                    }
                }
            }
        }
    }
    #[test]
    fn resident_rotation_and_equivalent_aliases_copy_zero_pixels_add_one_only_prepares_new_chunks()
    {
        let _serial = TEST_LOCK.lock().unwrap();
        let session = session();
        let cancel = Cancellation::default();
        let mut first = Plan::new(
            session.clone(),
            request("p1r42", None, Some("p2r44")),
            &cancel,
        )
        .unwrap();
        first.prepare(&[], &cancel).unwrap();
        let resident: Vec<_> = first.chunks.values().cloned().collect();
        let mut rotated = Plan::new(
            session.clone(),
            request("p2r44", Some("p1r13"), None),
            &cancel,
        )
        .unwrap();
        assert_eq!(
            first.required.keys().collect::<Vec<_>>(),
            rotated.required.keys().collect::<Vec<_>>()
        );
        assert!(
            rotated
                .prepare(&resident, &cancel)
                .unwrap()
                .bytes
                .is_empty()
        );
        let mut extended = Plan::new(
            session,
            request("p2r44", Some("p1r13"), Some("p3r42")),
            &cancel,
        )
        .unwrap();
        let missing = extended.prepare(&resident, &cancel).unwrap();
        assert_eq!(missing.chunks.len(), 2);
        assert!(missing.chunks.iter().all(|chunk| {
            chunk.layout.field.as_ref().map(|field| field.id).or(chunk
                .layout
                .role
                .as_ref()
                .map(|role| role.hold.id))
                == Some(3)
        }));
    }
    #[test]
    fn encoding_preserves_original_order_membership_and_tile_indices() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let mut plan = Plan::new(
            session(),
            request("p2r42p1r44", Some("p2r13p1r42"), Some("p2r13")),
            &cancel,
        )
        .unwrap();
        plan.baseline = Some(HashMap::from([(2, 13), (1, 13)]));
        plan.prepare(&[], &cancel).unwrap();
        let packet = plan.encode(placements(&plan), &cancel).unwrap();
        let current = packet.scenes[0];
        assert_eq!(current.count, 2);
        assert_eq!(word(&packet.descriptors, current.offset + 80), 2);
        assert_eq!(
            word(&packet.descriptors, current.offset + DESCRIPTOR_BYTES + 80),
            1
        );
        assert_eq!(
            word(&packet.descriptors, current.offset + 72),
            1_f32.to_bits()
        );
        assert_eq!(
            word(&packet.descriptors, current.offset + 76),
            1_f32.to_bits()
        );
        assert_eq!(
            word(&packet.descriptors, current.offset + DESCRIPTOR_BYTES + 68),
            1_f32.to_bits()
        );
        assert_eq!(
            word(&packet.descriptors, current.offset + DESCRIPTOR_BYTES + 72),
            2_f32.to_bits()
        );
        let directory = current.tile_directory as usize * 4;
        for tile in 0..16 {
            let first = word(&packet.resources, directory + tile * 8) as usize * 4;
            let count = word(&packet.resources, directory + tile * 8 + 4) as usize;
            let indices = (0..count)
                .map(|index| word(&packet.resources, first + index * 4))
                .collect::<Vec<_>>();
            assert!(indices.windows(2).all(|pair| pair[0] < pair[1]));
            for ordinal in indices {
                assert!(ordinal < 2);
            }
        }
        let mut uniforms = [0; UNIFORM_BYTES];
        packet
            .encode_uniforms(
                0,
                2,
                Reveal::Wipe { progress: 0.5 },
                1.35,
                [100.0, 100.0],
                true,
                true,
                &mut uniforms,
            )
            .unwrap();
        assert_eq!(word(&uniforms, 96), 0.5_f32.to_bits());
        assert_eq!(word(&uniforms, 108), 1.35_f32.to_bits());
        assert_eq!(word(&uniforms, 72), packet.scenes[0].tile_directory);
        assert_eq!(word(&uniforms, 76), packet.scenes[2].tile_directory);
        // The wipe leaves the swap weights, shared weight and mode zero: earlier
        // bytes, unchanged.
        for offset in [60, 88, 92, 104] {
            assert_eq!(word(&uniforms, offset), 0);
        }
        assert!(
            packet
                .encode_uniforms(
                    0,
                    2,
                    Reveal::Wipe { progress: f32::NAN },
                    1.0,
                    [100.0, 100.0],
                    false,
                    false,
                    &mut uniforms
                )
                .is_err()
        );
    }
    /// `weights` are the lower-only, upper-only and shared hold weights.
    fn swap_uniforms(packet: &Packet, lower: usize, upper: usize, weights: [f32; 3]) -> [u8; 144] {
        let mut uniforms = [0; UNIFORM_BYTES];
        packet
            .encode_uniforms(
                lower,
                upper,
                Reveal::Swap {
                    lower: weights[0],
                    upper: weights[1],
                    shared: weights[2],
                },
                1.0,
                [100.0, 100.0],
                true,
                false,
                &mut uniforms,
            )
            .unwrap();
        uniforms
    }
    #[test]
    fn swap_carries_class_weights_and_reaches_a_still_only_when_settled() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let mut plan = Plan::new(
            session(),
            request("p2r42p1r44", Some("p1r42"), Some("p2r13")),
            &cancel,
        )
        .unwrap();
        plan.prepare(&[], &cancel).unwrap();
        let packet = plan.encode(placements(&plan), &cancel).unwrap();
        let (lower_layers, upper_layers) =
            (packet.scenes[0].stamp_layers, packet.scenes[2].stamp_layers);
        // Dimmed outgoing-only holds at the commit point; nothing incoming yet.
        let dimmed = swap_uniforms(&packet, 0, 2, [0.4, 0.0, 1.0]);
        assert_eq!(word(&dimmed, 88), 0.4_f32.to_bits());
        assert_eq!(word(&dimmed, 92), 0);
        assert_eq!(word(&dimmed, 104), 1_f32.to_bits());
        assert_eq!(word(&dimmed, 100), REVEAL_BAND.to_bits());
        let progress = f32::from_bits(word(&dimmed, 96));
        assert!(
            progress > 0.0 && progress < 1.0,
            "a dimmed wall is mid-transition"
        );
        assert_eq!(word(&dimmed, 68), lower_layers | upper_layers);
        // Only a settled side uses the still compositor and its own layers.
        let settled_lower = swap_uniforms(&packet, 0, 2, [1.0, 0.0, 1.0]);
        assert_eq!(word(&settled_lower, 96), 0);
        assert_eq!(word(&settled_lower, 68), lower_layers);
        let settled_upper = swap_uniforms(&packet, 0, 2, [0.0, 1.0, 1.0]);
        assert_eq!(word(&settled_upper, 96), 1_f32.to_bits());
        assert_eq!(word(&settled_upper, 68), upper_layers);
        for weights in [
            [0.0, 0.0],
            [1.0, 1.0],
            [0.2, 0.3],
            [1.0, 0.0001],
            [0.9999, 0.0],
        ] {
            let [lower, upper] = weights;
            let progress =
                f32::from_bits(word(&swap_uniforms(&packet, 0, 2, [lower, upper, 1.0]), 96));
            assert!(
                progress > 0.0 && progress < 1.0,
                "{weights:?} is not settled"
            );
        }
        // One scene twice is that scene's still, whatever the weights say.
        assert_eq!(word(&swap_uniforms(&packet, 0, 0, [0.4, 0.2, 1.0]), 96), 0);
        // The pair is position-independent: display mirroring changes nothing else.
        let mut mirrored = [0; UNIFORM_BYTES];
        packet
            .encode_uniforms(
                0,
                2,
                Reveal::Swap {
                    lower: 0.4,
                    upper: 0.0,
                    shared: 1.0,
                },
                1.0,
                [100.0, 100.0],
                true,
                true,
                &mut mirrored,
            )
            .unwrap();
        assert_eq!(dimmed[..124], mirrored[..124]);
        assert_eq!(dimmed[128..], mirrored[128..]);
        for (mode, lower, upper, shared) in [
            (REVEAL_MODE_SWAP, f32::NAN, 0.0, 1.0),
            (REVEAL_MODE_SWAP, 0.0, 1.5, 1.0),
            (REVEAL_MODE_SWAP, -0.1, 0.0, 1.0),
            (REVEAL_MODE_SWAP, 0.4, 0.0, f32::NAN),
            (REVEAL_MODE_SWAP, 0.4, 0.0, 1.01),
            (REVEAL_MODE_SWAP, 0.4, 0.0, -0.01),
            (2, 0.0, 0.0, 1.0),
        ] {
            assert!(Reveal::from_native(mode, 0.0, lower, upper, shared).is_err());
        }
        assert_eq!(
            Reveal::from_native(REVEAL_MODE_WIPE, 0.25, f32::NAN, 9.0, -3.0),
            Ok(Reveal::Wipe { progress: 0.25 }),
            "the wipe ignores the swap slots"
        );
    }
    #[test]
    fn swap_weights_shared_holds_only_in_the_weighted_compositor() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let mut plan = Plan::new(
            session(),
            request("p2r42p1r44", Some("p1r42"), Some("p2r13")),
            &cancel,
        )
        .unwrap();
        plan.prepare(&[], &cancel).unwrap();
        let packet = plan.encode(placements(&plan), &cancel).unwrap();
        // Dragging at the commit point: shared holds dip with the outgoing ones.
        let dipped = swap_uniforms(&packet, 0, 2, [0.4, 0.0, 0.4]);
        assert_eq!(word(&dipped, 60), 0.4_f32.to_bits());
        // Native API 6 bytes plus one word: shared holds whole fill tuning2.w.
        let whole = swap_uniforms(&packet, 0, 2, [0.4, 0.0, 1.0]);
        assert_eq!(word(&whole, 60), 1_f32.to_bits());
        assert_eq!(dipped[..60], whole[..60]);
        assert_eq!(dipped[64..], whole[64..]);
        // A settled side with shared holds whole is a still: API 6's bytes, word 15 zero.
        for weights in [[1.0, 0.0, 1.0], [0.0, 1.0, 1.0]] {
            let still = swap_uniforms(&packet, 0, 2, weights);
            let progress = f32::from_bits(word(&still, 96));
            assert!(progress == 0.0 || progress == 1.0);
            assert_eq!(word(&still, 60), 0);
        }
        assert_eq!(word(&swap_uniforms(&packet, 0, 0, [0.4, 0.2, 0.4]), 60), 0);
        // Dimmed shared holds never take the still compositor, which draws them whole.
        let (lower_layers, upper_layers) =
            (packet.scenes[0].stamp_layers, packet.scenes[2].stamp_layers);
        for weights in [[1.0, 0.0, 0.9], [0.0, 1.0, 0.4], [1.0, 0.0, 0.0]] {
            let uniforms = swap_uniforms(&packet, 0, 2, weights);
            let progress = f32::from_bits(word(&uniforms, 96));
            assert!(progress > 0.0 && progress < 1.0, "{weights:?} took a still");
            assert_eq!(word(&uniforms, 60), weights[2].to_bits());
            assert_eq!(word(&uniforms, 68), lower_layers | upper_layers);
        }
        // Toward an empty climb no hold is shared: the veil still follows the lit side.
        let mut plan = Plan::new(session(), request("p1r42", Some(""), Some("")), &cancel).unwrap();
        plan.prepare(&[], &cancel).unwrap();
        let empty = plan.encode(placements(&plan), &cancel).unwrap();
        assert_eq!(word(&swap_uniforms(&empty, 0, 2, [1.0, 0.0, 0.4]), 96), 0);
        assert_eq!(
            f32::from_bits(word(&swap_uniforms(&empty, 0, 2, [0.4, 0.0, 0.4]), 96)),
            0.6
        );
        assert_eq!(
            Reveal::from_native(REVEAL_MODE_SWAP, 0.0, 0.4, 0.0, 0.4),
            Ok(Reveal::Swap {
                lower: 0.4,
                upper: 0.0,
                shared: 0.4
            })
        );
    }
    #[test]
    fn swap_toward_an_empty_climb_fades_the_veil_with_the_lit_side() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let mut plan = Plan::new(session(), request("p1r42", Some(""), Some("")), &cancel).unwrap();
        plan.prepare(&[], &cancel).unwrap();
        let packet = plan.encode(placements(&plan), &cancel).unwrap();
        assert_eq!(packet.scenes[2].count, 0);
        // Lit lower, empty upper: veil = mix(1, 0, progress) = the lower weight.
        let leaving = swap_uniforms(&packet, 0, 2, [0.4, 0.0, 1.0]);
        assert_eq!(f32::from_bits(word(&leaving, 96)), 0.6);
        assert_eq!(word(&swap_uniforms(&packet, 0, 2, [1.0, 0.7, 1.0]), 96), 0);
        assert_eq!(
            word(&swap_uniforms(&packet, 0, 2, [0.0, 0.0, 1.0]), 96),
            1_f32.to_bits()
        );
        // Empty lower, lit upper: veil = mix(0, 1, progress) = the upper weight.
        let arriving = swap_uniforms(&packet, 1, 0, [0.0, 0.25, 1.0]);
        assert_eq!(f32::from_bits(word(&arriving, 96)), 0.25);
        assert_eq!(
            word(&swap_uniforms(&packet, 1, 0, [1.0, 1.0, 1.0]), 96),
            1_f32.to_bits()
        );
    }
    #[test]
    fn annotation_has_no_field_and_its_independent_marker_tiles_are_retained() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let mut plan = Plan::new(session(), request("p1r46", None, None), &cancel).unwrap();
        let prepared = plan.prepare(&[], &cancel).unwrap();
        assert_eq!(prepared.chunks.len(), 1);
        assert!(prepared.chunks[0].layout.field.is_none());
        let packet = plan.encode(placements(&plan), &cancel).unwrap();
        assert_eq!(packet.scenes[0].max_reach, 0.0);
        assert_eq!(packet.scenes[0].stamp_layers, 8);
        let role = prepared.chunks[0].layout.role.as_ref().unwrap();
        for stamp in role.glyphs.iter().flatten() {
            for y in stamp.y..stamp.y + stamp.height {
                for x in stamp.x..stamp.x + stamp.width {
                    let tile = (y / TILE_EDGE) * 4 + x / TILE_EDGE;
                    let directory =
                        packet.scenes[0].tile_directory as usize * 4 + tile as usize * 8;
                    assert_eq!(word(&packet.resources, directory + 4), 1);
                }
            }
        }
    }
    #[test]
    fn malformed_placements_and_per_source_bounds_fail_before_packet_publication() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let session = session();
        let too_many = (0..129).map(|_| "p1r42").collect::<String>();
        assert!(Plan::new(session.clone(), request(&too_many, None, None), &cancel).is_err());
        let mut plan = Plan::new(session, request("p1r42", None, None), &cancel).unwrap();
        plan.prepare(&[], &cancel).unwrap();
        let mut bad = placements(&plan);
        bad.chunks[1].offset = bad.chunks[0].offset;
        assert!(plan.encode(bad, &cancel).is_err());
        let mut bad = placements(&plan);
        bad.chunks[0].offset = 1;
        assert!(plan.encode(bad, &cancel).is_err());
        let mut bad = placements(&plan);
        bad.chunks[0].bytes += 4;
        assert!(plan.encode(bad, &cancel).is_err());
        let cancel = Cancellation::default();
        cancel.cancel();
        assert!(plan.prepare(&[], &cancel).is_err());
    }
    #[test]
    fn nonrenderable_and_fully_offboard_holds_are_skipped_like_the_full_atlas() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let mut config = fixture();
        config["holds"][0]["r"] = json!(0);
        config["holds"][2]["cx"] = json!(1000);
        let session = Session::from_json(&serde_json::to_vec(&config).unwrap(), &cancel).unwrap();
        let mut plan = Plan::new(session, request("p1r42p3r42p2r42", None, None), &cancel).unwrap();
        assert_eq!(plan.scenes[0].len(), 1);
        assert_eq!(plan.scenes[0][0].id, 2);
        plan.prepare(&[], &cancel).unwrap();
        assert_eq!(plan.chunks.len(), 2);
    }
    #[test]
    fn zero_pixel_roles_still_obey_metadata_entry_and_byte_bounds() {
        let mut cache = ChunkCache::default();
        for index in 0..5000 {
            cache.insert(
                Arc::new(ChunkLayout {
                    key: format!("{index:064x}"),
                    bytes: 0,
                    field: None,
                    role: None,
                    covers: None,
                }),
                Arc::new(Vec::new()),
            );
        }
        assert_eq!(cache.entries.len(), 4096);
        assert!(cache.bytes > 0 && cache.bytes <= MAX_CPU_BYTES);
        assert!(cache.get(&format!("{:064x}", 0)).is_none());
        assert!(cache.get(&format!("{:064x}", 4999)).is_some());
    }
    #[test]
    fn one_corrupt_local_chunk_regenerates_only_that_chunk_and_reports_sources() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let session = session();
        let directory = std::env::temp_dir()
            .join(format!("aura-packet-corrupt-{}", std::process::id()))
            .join("aura-lazy-v1");
        session.set_cache_directory(directory.clone()).unwrap();
        let mut original = Plan::new(
            session.clone(),
            request("p1r42", None, Some("p2r44")),
            &cancel,
        )
        .unwrap();
        let prepared = original.prepare(&[], &cancel).unwrap();
        for chunk in &prepared.chunks {
            super::super::gpu_packet_cache::write(
                &directory,
                &session.identity,
                &chunk.layout,
                &prepared.bytes[chunk.source_offset..chunk.source_offset + chunk.layout.bytes],
            )
            .unwrap();
        }
        let corrupt = prepared
            .chunks
            .iter()
            .find(|chunk| chunk.layout.field.is_some())
            .unwrap();
        let path = directory
            .join(&session.identity)
            .join(format!("{}.chunk", corrupt.layout.key));
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[15] ^= 1;
        std::fs::write(path, bytes).unwrap();
        {
            let mut cache = CHUNKS.lock().unwrap();
            cache.entries.clear();
            cache.bytes = 0;
        }
        let mut restarted =
            Plan::new(session, request("p1r42", None, Some("p2r44")), &cancel).unwrap();
        restarted.prepare(&[], &cancel).unwrap();
        assert_eq!(restarted.sources.local_cache_hits, 3);
        assert_eq!(restarted.sources.local_cache_corrupt, 1);
        assert_eq!(restarted.sources.generated_misses, 1);
        assert_eq!(restarted.sources.cpu_cache_hits, 0);
        let _ = std::fs::remove_dir_all(directory.parent().unwrap());
    }
    #[test]
    fn first_frame_never_creates_a_cache_directory_or_writes_compressed_chunks() {
        let _serial = TEST_LOCK.lock().unwrap();
        let cancel = Cancellation::default();
        let session = session();
        let directory = std::env::temp_dir()
            .join(format!("aura-lazy-no-prepare-write-{}", std::process::id()))
            .join("aura-lazy-v1");
        assert!(!directory.exists());
        session.set_cache_directory(directory.clone()).unwrap();
        let mut plan = Plan::new(session, request("p1r42", None, None), &cancel).unwrap();
        plan.prepare(&[], &cancel).unwrap();
        assert!(
            !directory.exists(),
            "only explicit post-ready persistence may create files"
        );
    }
    #[test]
    fn cumulative_raster_work_survives_cancelled_output_and_partial_roles() {
        let _serial = TEST_LOCK.lock().unwrap();
        let config: RenderConfig = serde_json::from_value(fixture()).unwrap();
        let before = super::super::gpu_packet_stats::thread_snapshot();
        let global = super::super::gpu_packet_stats::snapshot();
        let mut selection = AtlasSelection::default();
        selection.fields.insert(1);
        selection.roles.entry(1).or_default().insert(13);
        let result = prepare_subset_checked(&config, None, Some(&selection), &|| {
            let observed = super::super::gpu_packet_stats::thread_snapshot();
            if observed.field_raster_completed > before.field_raster_completed {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        let after = super::super::gpu_packet_stats::thread_snapshot();
        assert_eq!(
            after.field_raster_attempts - before.field_raster_attempts,
            1
        );
        assert_eq!(
            after.field_raster_completed - before.field_raster_completed,
            1
        );
        assert!(
            super::super::gpu_packet_stats::snapshot().cpu_field_materializations
                > global.cpu_field_materializations
        );
        selection.fields.clear();
        let before = super::super::gpu_packet_stats::thread_snapshot();
        let result = prepare_subset_checked(&config, None, Some(&selection), &|| {
            let observed = super::super::gpu_packet_stats::thread_snapshot();
            if observed.role_raster_attempts > before.role_raster_attempts {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        let after = super::super::gpu_packet_stats::thread_snapshot();
        assert_eq!(after.role_raster_attempts - before.role_raster_attempts, 1);
        assert_eq!(
            after.role_raster_completed - before.role_raster_completed,
            0
        );
    }
}
