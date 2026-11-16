//! Versioned geometry only: each hold is an independently bounded deflate chunk.
//! Colours, role stamps, covers and falloff are assembled from the current config.
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::gpu_atlas::{PreparedAtlas, prepare_owned};
use super::gpu_constants::{EDIT_PEAK_REACH, MAX_GPU_BYTES as MAX_PIXELS};
use crate::types::{HoldData, RenderConfig};

const MAGIC: &[u8; 8] = b"AURAGEO1";
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_HEADER: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Chunk {
    id: u32,
    identity: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    offset: u64,
    compressed: usize,
    raw: usize,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
struct Header {
    version: u32,
    width: u32,
    height: u32,
    pulse_reach: f32,
    geometry_id: String,
    max_reach: f32,
    #[serde(default)]
    scope: Option<String>,
    chunks: Vec<Chunk>,
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn hold_identity(config: &RenderConfig, hold: &HoldData) -> String {
    // Serialize exact f32 inputs used by LitHold, including the seed treatment.
    // LED covers, lightness, roles, mirrors and animation do not affect fields.
    sha256(
        &serde_json::to_vec(&serde_json::json!([
            "aura-field-v2-edt1",
            config.board_width,
            config.board_height,
            config.output_width,
            hold.id,
            hold.cx,
            hold.cy,
            hold.r,
            hold.outline,
            hold.led_inner,
            config.led_base.opacity.is_finite()
                && config.led_base.opacity > 0.0
                && super::effective_mark_style(config) != crate::types::MarkStyle::NoMark
                && config.led_base.glow_from_base
        ]))
        .expect("finite geometry serializes"),
    )
}

/// Build artifacts, never bundled binaries. Source ordering is preserved.
pub fn encode(config: &RenderConfig, atlas: &PreparedAtlas) -> Result<Vec<u8>, String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(&atlas.manifest).map_err(|error| error.to_string())?;
    let mut chunks = Vec::new();
    let mut compressed_pixels = Vec::new();
    let mut max_reach = 0.0_f32;
    let source_holds: HashMap<_, _> = config.holds.iter().map(|hold| (hold.id, hold)).collect();
    for hold in manifest["holds"].as_array().ok_or("Missing atlas holds")? {
        let number = |name: &str| -> Result<u32, String> {
            hold[name]
                .as_u64()
                .and_then(|number| u32::try_from(number).ok())
                .ok_or_else(|| format!("Invalid {name}"))
        };
        let id = number("id")?;
        let width = number("width")?;
        let height = number("height")?;
        let raw = width as usize * height as usize * 4;
        let field = number("field")? as usize;
        let pixels = atlas
            .pixels
            .get(field..field.checked_add(raw).ok_or("Field overflow")?)
            .ok_or("Missing atlas pixels")?;
        let compressed = miniz_oxide::deflate::compress_to_vec(pixels, 6);
        chunks.push(Chunk {
            id,
            identity: hold_identity(config, source_holds.get(&id).ok_or("Missing source hold")?),
            x: number("x")?,
            y: number("y")?,
            width,
            height,
            offset: compressed_pixels.len() as u64,
            compressed: compressed.len(),
            raw,
            sha256: sha256(pixels),
        });
        compressed_pixels.extend_from_slice(&compressed);
        max_reach = max_reach.max(hold["reach"].as_f64().ok_or("Missing reach")? as f32);
    }
    let geometry_id = sha256(
        &serde_json::to_vec(
            &chunks
                .iter()
                .map(|chunk| &chunk.identity)
                .collect::<Vec<_>>(),
        )
        .map_err(|error| error.to_string())?,
    );
    let header = Header {
        version: 2,
        width: manifest["width"].as_u64().ok_or("Missing width")? as u32,
        height: manifest["height"].as_u64().ok_or("Missing height")? as u32,
        pulse_reach: EDIT_PEAK_REACH,
        geometry_id,
        max_reach,
        scope: config.geometry_cache_scope.clone(),
        chunks,
    };
    let header = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
    if header.len() > MAX_HEADER || header.len() + 12 + compressed_pixels.len() > MAX_FILE as usize
    {
        return Err("Geometry artifact exceeds bounds".into());
    }
    let mut result = Vec::with_capacity(12 + header.len() + compressed_pixels.len());
    result.extend_from_slice(MAGIC);
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend_from_slice(&header);
    result.extend_from_slice(&compressed_pixels);
    Ok(result)
}

pub fn generate(config: &RenderConfig) -> Result<Vec<u8>, String> {
    encode(config, &prepare_owned(config)?)
}

pub fn metadata(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let length = u32::from_le_bytes(
        bytes
            .get(8..12)
            .ok_or("Short geometry header")?
            .try_into()
            .map_err(|_| "Invalid header")?,
    ) as usize;
    let header: Header = serde_json::from_slice(
        bytes
            .get(12..12 + length)
            .ok_or("Truncated geometry header")?,
    )
    .map_err(|error| error.to_string())?;
    Ok(
        serde_json::json!({"geometryId":header.geometry_id,"formatRevision":header.version,
        "sha256":sha256(bytes),"bytes":bytes.len(),"maxReach":header.max_reach,"pulseReach":header.pulse_reach,
        "width":header.width,"height":header.height,"holds":header.chunks.len()}),
    )
}

pub struct GeometryReader {
    file: RefCell<File>,
    header: Header,
    by_id: HashMap<u32, usize>,
    payload_offset: u64,
}

impl GeometryReader {
    pub fn scope(&self) -> Option<&str> {
        self.header.scope.as_deref()
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::from_file(File::open(path).map_err(|error| error.to_string())?)
    }
    pub fn open_verified(path: &Path, expected_sha: &str) -> Result<Self, String> {
        let file = super::gpu_atlas::verified_geometry_file(path, expected_sha)?;
        Self::from_file(file)
    }
    fn from_file(mut file: File) -> Result<Self, String> {
        file.seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let length = file.metadata().map_err(|error| error.to_string())?.len();
        if !(12..=MAX_FILE).contains(&length) {
            return Err("Geometry file length out of bounds".into());
        }
        let mut prefix = [0_u8; 12];
        file.read_exact(&mut prefix)
            .map_err(|error| error.to_string())?;
        if &prefix[..8] != MAGIC {
            return Err("Incompatible geometry magic".into());
        }
        let header_length =
            u32::from_le_bytes(prefix[8..].try_into().map_err(|_| "Invalid prefix")?) as usize;
        if header_length > MAX_HEADER || header_length as u64 > length - 12 {
            return Err("Geometry header length out of bounds".into());
        }
        let mut header_bytes = vec![0; header_length];
        file.read_exact(&mut header_bytes)
            .map_err(|error| error.to_string())?;
        let header: Header =
            serde_json::from_slice(&header_bytes).map_err(|error| error.to_string())?;
        if header.version != 2
            || header.pulse_reach != EDIT_PEAK_REACH
            || header.width == 0
            || header.width > 1536
            || header.height == 0
            || header.height > 2304
            || header.chunks.len() > 1024
        {
            return Err("Incompatible geometry bounds".into());
        }
        let mut by_id = HashMap::new();
        let payload_offset = 12 + header_length as u64;
        let mut end = 0_u64;
        for (index, chunk) in header.chunks.iter().enumerate() {
            let raw = (chunk.width as usize)
                .checked_mul(chunk.height as usize)
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or("Geometry size overflow")?;
            if chunk.width == 0
                || chunk.height == 0
                || raw > MAX_PIXELS
                || chunk.raw != raw
                || chunk.compressed == 0
                || chunk.compressed > MAX_PIXELS
                || chunk.offset != end
                || chunk
                    .x
                    .checked_add(chunk.width)
                    .is_none_or(|right| right > header.width)
                || chunk
                    .y
                    .checked_add(chunk.height)
                    .is_none_or(|bottom| bottom > header.height)
                || by_id.insert(chunk.id, index).is_some()
            {
                return Err("Invalid geometry chunk bounds".into());
            }
            end = end
                .checked_add(chunk.compressed as u64)
                .ok_or("Geometry chunk overflow")?;
            if end > length - payload_offset {
                return Err("Truncated geometry chunk".into());
            }
        }
        if end != length - payload_offset {
            return Err("Unexpected geometry trailing bytes".into());
        }
        Ok(Self {
            file: RefCell::new(file),
            header,
            by_id,
            payload_offset,
        })
    }

    pub fn field(
        &self,
        config: &RenderConfig,
        hold: &HoldData,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        let (output_width, output_height) = crate::renderer::output_size(config)?;
        if output_width != self.header.width || output_height != self.header.height {
            return Err("Geometry resolution mismatch".into());
        }
        let chunk = &self.header.chunks[*self
            .by_id
            .get(&hold.id)
            .ok_or("Hold missing from geometry")?];
        if hold_identity(config, hold) != chunk.identity
            || x < chunk.x
            || y < chunk.y
            || x.checked_add(width)
                .is_none_or(|right| right > chunk.x + chunk.width)
            || y.checked_add(height)
                .is_none_or(|bottom| bottom > chunk.y + chunk.height)
        {
            return Err("Geometry or glow reach incompatible".into());
        }
        let mut compressed = vec![0; chunk.compressed];
        let mut file = self.file.borrow_mut();
        file.seek(SeekFrom::Start(self.payload_offset + chunk.offset))
            .map_err(|error| error.to_string())?;
        file.read_exact(&mut compressed)
            .map_err(|error| error.to_string())?;
        let raw = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, chunk.raw)
            .map_err(|error| format!("Corrupt geometry deflate: {error:?}"))?;
        if raw.len() != chunk.raw || sha256(&raw) != chunk.sha256 {
            return Err("Geometry length or hash mismatch".into());
        }
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for row in y - chunk.y..y - chunk.y + height {
            let start = (row as usize * chunk.width as usize + (x - chunk.x) as usize) * 4;
            pixels.extend_from_slice(&raw[start..start + width as usize * 4]);
        }
        Ok(pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aura::gpu_atlas::{prepare_cached, prepare_with_geometry};
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    fn directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aura-geometry-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn config() -> RenderConfig {
        serde_json::from_value(
            json!({"board_width":100,"board_height":100,"output_width":100,
            "frames":"p1r42","thumbnail":false,"render_mode":"aura",
            "holds":[{"id":1,"cx":25,"cy":35,"r":6},{"id":2,"cx":60,"cy":65,"r":15}],
            "hold_state_map":{"42":{"color":"#00FF00","role":"starting"}}}),
        )
        .unwrap()
    }
    #[test]
    fn generation_is_deterministic_and_reconstruction_is_exact_for_selected_sets() {
        let directory = directory();
        let path = directory.join("prebuilt.aura");
        let mut config = config();
        let bytes = generate(&config).unwrap();
        assert_eq!(bytes, generate(&config).unwrap());
        std::fs::write(&path, &bytes).unwrap();
        for subset in [false, true] {
            if subset {
                config.holds.pop();
            }
            let local = prepare_owned(&config).unwrap();
            let prebuilt = prepare_with_geometry(&config, &path).unwrap();
            assert_eq!(local.manifest, prebuilt.manifest);
            assert_eq!(local.pixels, prebuilt.pixels);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn themes_and_falloff_share_fields_but_geometry_changes_do_not() {
        let directory = directory();
        let path = directory.join("prebuilt.aura");
        let mut config = config();
        std::fs::write(&path, generate(&config).unwrap()).unwrap();
        let key = crate::aura::gpu_atlas::geometry_cache_key(&config);
        config.hold_state_map.get_mut(&42).unwrap().color = "#FF00FF".into();
        config.veil = Some(crate::types::Veil {
            color: "#FFFFFF".into(),
            opacity: 0.3,
        });
        config.glow_falloff = crate::types::GlowFalloff::Plateau;
        assert_eq!(key, crate::aura::gpu_atlas::geometry_cache_key(&config));
        let atlas = prepare_with_geometry(&config, &path).unwrap();
        let local = prepare_owned(&config).unwrap();
        assert_eq!(atlas.manifest, local.manifest);
        assert_eq!(atlas.pixels, local.pixels);
        config.holds[0].r += 1.0;
        assert!(prepare_with_geometry(&config, &path).is_err());
        config.holds[0].r -= 1.0;
        config.glow.reach_scale = 2.0;
        assert!(prepare_with_geometry(&config, &path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn corrupt_truncated_and_incompatible_assets_fall_back_without_changing_pixels() {
        let directory = directory();
        let path = directory.join("prebuilt.aura");
        let config = config();
        let bytes = generate(&config).unwrap();
        let expected_sha = sha256(&bytes);
        let expected = prepare_owned(&config).unwrap();
        for corruption in [0, bytes.len() / 2, bytes.len() - 1] {
            let mut corrupt = bytes.clone();
            corrupt[corruption] ^= 1;
            std::fs::write(&path, &corrupt).unwrap();
            assert!(GeometryReader::open_verified(&path, &expected_sha).is_err());
            let fallback = prepare_cached(&config, Some((&path, &expected_sha)), None).unwrap();
            assert_eq!(fallback.manifest, expected.manifest);
            assert_eq!(fallback.pixels, expected.pixels);
        }
        for length in [0, 8, 12, bytes.len() - 1] {
            std::fs::write(&path, &bytes[..length]).unwrap();
            assert!(prepare_with_geometry(&config, &path).is_err());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn disk_failures_are_optional_and_generated_artifacts_survive_process_local_cache_misses() {
        let directory = directory();
        let config = config();
        let expected = prepare_owned(&config).unwrap();
        let first = prepare_cached(&config, None, Some(&directory)).unwrap();
        assert_eq!(first.pixels, expected.pixels);
        let count = std::fs::read_dir(&directory).unwrap().count();
        assert_eq!(count, 1);
        let repeated = prepare_cached(&config, None, Some(&directory)).unwrap();
        assert_eq!(repeated.manifest, expected.manifest);
        assert_eq!(repeated.pixels, expected.pixels);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), count);
        let file = directory.join("not-a-directory");
        std::fs::write(&file, b"occupied").unwrap();
        assert_eq!(
            prepare_cached(&config, None, Some(&file)).unwrap().pixels,
            expected.pixels
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn decompression_and_header_lengths_are_checked_before_allocation() {
        let directory = directory();
        let path = directory.join("prebuilt.aura");
        let mut bytes = generate(&config()).unwrap();
        bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert!(GeometryReader::open(&path).is_err());
        let mut bytes = generate(&config()).unwrap();
        let length = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let mut header: Header = serde_json::from_slice(&bytes[12..12 + length]).unwrap();
        header.chunks[0].raw = usize::MAX;
        let invalid = serde_json::to_vec(&header).unwrap();
        bytes.splice(12..12 + length, invalid.iter().copied());
        bytes[8..12].copy_from_slice(&(invalid.len() as u32).to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert!(GeometryReader::open(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
