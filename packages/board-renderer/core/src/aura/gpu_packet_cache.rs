//! Optional private chunk cache. Compression/writes run only after ready.
use super::gpu_geometry::sha256;
use super::gpu_packet::{ChunkLayout, MAX_GPU_BYTES, MAX_HEADER_BYTES, cached_for_persistence};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::{LazyLock, mpsc};

const MAGIC: &[u8; 8] = b"AURACHK1";
const LIMIT: u64 = 256 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    layout: ChunkLayout,
    raw_sha256: String,
}
pub(super) enum ReadResult {
    Missing,
    Corrupt,
    Hit(Arc<ChunkLayout>, Vec<u8>),
}
pub(super) fn read(
    directory: &Path,
    scope: &str,
    key: &str,
    validate: impl Fn(&ChunkLayout) -> bool,
) -> ReadResult {
    let path = directory.join(scope).join(format!("{key}.chunk"));
    let Ok(mut file) = std::fs::File::open(path) else {
        return ReadResult::Missing;
    };
    let result = (|| -> Result<_, String> {
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        if !(44..=(MAX_GPU_BYTES + MAX_HEADER_BYTES + 44) as u64).contains(&size) {
            return Err("chunk file bounds".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(size + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 != size || &bytes[..8] != MAGIC {
            return Err("chunk file changed or invalid magic".into());
        }
        let checksum = bytes.split_off(bytes.len() - 32);
        let expected = hex_bytes(&sha256(&bytes))?;
        if checksum != expected {
            return Err("chunk container checksum".into());
        }
        let header_bytes =
            u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| "chunk header")?) as usize;
        if header_bytes > MAX_HEADER_BYTES || header_bytes > bytes.len() - 12 {
            return Err("chunk header bounds".into());
        }
        let header: Header = serde_json::from_slice(&bytes[12..12 + header_bytes])
            .map_err(|error| error.to_string())?;
        if header.version != 1
            || header.layout.key != key
            || header.layout.bytes > MAX_GPU_BYTES
            || header.raw_sha256.len() != 64
            || !header
                .raw_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !validate(&header.layout)
        {
            return Err("chunk identity or raw bounds".into());
        }
        let raw = if header.layout.bytes == 0 {
            if bytes.len() != 12 + header_bytes {
                return Err("empty chunk trailing bytes".into());
            }
            Vec::new()
        } else {
            miniz_oxide::inflate::decompress_to_vec_with_limit(
                &bytes[12 + header_bytes..],
                header.layout.bytes,
            )
            .map_err(|_| "chunk deflate")?
        };
        if raw.len() != header.layout.bytes || sha256(&raw) != header.raw_sha256 {
            return Err("chunk raw checksum".into());
        }
        Ok((header.layout, raw))
    })();
    match result {
        Ok((layout, bytes)) => ReadResult::Hit(Arc::new(layout), bytes),
        Err(_) => ReadResult::Corrupt,
    }
}
fn hex_bytes(hex: &str) -> Result<Vec<u8>, String> {
    hex.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            std::str::from_utf8(pair)
                .map_err(|_| "invalid checksum".to_owned())
                .and_then(|pair| {
                    u8::from_str_radix(pair, 16).map_err(|_| "invalid checksum".to_owned())
                })
        })
        .collect()
}
struct Job {
    directory: PathBuf,
    scope: String,
    keys: Vec<String>,
    _work: super::gpu_packet_stats::Work,
}
static WRITER: LazyLock<Option<mpsc::SyncSender<Job>>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::sync_channel::<Job>(1);
    let worker = std::thread::Builder::new()
        .name("aura-chunk-cache".into())
        .spawn(move || {
            while let Ok(job) = receiver.recv() {
                for key in job.keys {
                    // Queue entries contain keys, not retained pixel buffers.
                    if let Some((layout, bytes)) = cached_for_persistence(&key) {
                        let _ = write(&job.directory, &job.scope, &layout, &bytes);
                    }
                }
            }
        });
    worker.ok().map(|_| sender)
});
pub(super) fn schedule(directory: PathBuf, scope: String, keys: Vec<String>) -> bool {
    if keys.is_empty() {
        return true;
    }
    WRITER.as_ref().is_some_and(|sender| {
        sender
            .try_send(Job {
                directory,
                scope,
                keys,
                _work: super::gpu_packet_stats::cache_write(),
            })
            .is_ok()
    })
}
fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}
pub(super) fn write(
    directory: &Path,
    scope: &str,
    layout: &ChunkLayout,
    raw: &[u8],
) -> Result<(), String> {
    if !valid_key(scope) || !valid_key(&layout.key) || raw.len() != layout.bytes {
        return Err("invalid private cache identity".into());
    }
    let header = serde_json::to_vec(&Header {
        version: 1,
        layout: layout.clone(),
        raw_sha256: sha256(raw),
    })
    .map_err(|error| error.to_string())?;
    if header.len() > MAX_HEADER_BYTES || raw.len() > MAX_GPU_BYTES {
        return Err("chunk size bounds".into());
    }
    let compressed = if raw.is_empty() {
        Vec::new()
    } else {
        miniz_oxide::deflate::compress_to_vec(raw, 6)
    };
    let mut bytes = Vec::with_capacity(12 + header.len() + compressed.len() + 32);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&compressed);
    bytes.extend_from_slice(&hex_bytes(&sha256(&bytes))?);
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    admit(directory, scope, bytes.len() as u64)?;
    let entry = directory.join(scope);
    std::fs::create_dir_all(&entry).map_err(|error| error.to_string())?;
    let destination = entry.join(format!("{}.chunk", layout.key));
    // Include destination plus temporary bytes in admission. No fsync in prepare.
    let partial = entry.join(format!(".{}.part", layout.key));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&partial, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(partial);
    }
    result
}
fn admit(directory: &Path, current: &str, incoming: u64) -> Result<(), String> {
    if incoming > LIMIT {
        return Err("chunk exceeds disk budget".into());
    }
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_key(&name)
            || !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
        {
            continue;
        }
        let mut size = 0_u64;
        for file in std::fs::read_dir(entry.path()).map_err(|error| error.to_string())? {
            let file = file.map_err(|error| error.to_string())?;
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            if metadata.is_file() {
                size = size
                    .checked_add(metadata.len())
                    .ok_or("cache size overflow")?;
            }
        }
        // An entry larger than the entire ceiling cannot be a valid cache.
        // Maintenance runs only in this optional background writer.
        if size > LIMIT {
            std::fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
            continue;
        }
        total = total.checked_add(size).ok_or("cache size overflow")?;
        entries.push((
            name.clone(),
            entry.path(),
            size,
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok(),
        ));
    }
    let current_exists = entries.iter().any(|entry| entry.0 == current);
    let mut count = entries.len() + usize::from(!current_exists);
    entries.sort_by_key(|entry| entry.3);
    for (name, path, size, _) in entries {
        if count <= 4 && total.saturating_add(incoming) <= LIMIT {
            break;
        }
        if name == current {
            continue;
        }
        std::fs::remove_dir_all(path).map_err(|error| error.to_string())?;
        count -= 1;
        total -= size;
    }
    // Optional admission skips an incoming chunk instead of destroying current data.
    if count > 4 || total.saturating_add(incoming) > LIMIT {
        return Err("private chunk cache full".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independently_compressed_chunks_validate_hashes_and_exact_lengths() {
        let directory =
            std::env::temp_dir().join(format!("aura-lazy-cache-{}", std::process::id()));
        let scope = "a".repeat(64);
        let key = "b".repeat(64);
        let layout = ChunkLayout {
            key: key.clone(),
            bytes: 4,
            field: None,
            role: None,
            covers: None,
        };
        write(&directory, &scope, &layout, &[1, 2, 3, 4]).unwrap();
        assert!(
            matches!(read(&directory,&scope,&key,|_|true),ReadResult::Hit(_,bytes)if bytes==[1,2,3,4])
        );
        let path = directory.join(&scope).join(format!("{key}.chunk"));
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[15] ^= 1;
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            read(&directory, &scope, &key, |_| true),
            ReadResult::Corrupt
        ));
        let _ = std::fs::remove_dir_all(directory);
    }
    #[test]
    fn admission_counts_temporary_bytes_and_both_disk_ceilings() {
        let directory =
            std::env::temp_dir().join(format!("aura-lazy-disk-budget-{}", std::process::id()));
        for index in 0..5 {
            let entry = directory.join(format!("{index:064x}"));
            std::fs::create_dir_all(&entry).unwrap();
            std::fs::File::create(entry.join("owned.chunk"))
                .unwrap()
                .set_len(60 * 1024 * 1024)
                .unwrap();
        }
        let current = format!("{:064x}", 4);
        admit(&directory, &current, 32 * 1024 * 1024).unwrap();
        let entries = std::fs::read_dir(&directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(entries.len() <= 4);
        let total: u64 = entries
            .iter()
            .map(|entry| {
                std::fs::read_dir(entry.path())
                    .unwrap()
                    .map(|file| file.unwrap().metadata().unwrap().len())
                    .sum::<u64>()
            })
            .sum();
        assert!(total + 32 * 1024 * 1024 <= LIMIT);
        assert!(admit(&directory, &current, LIMIT + 1).is_err());
        let _ = std::fs::remove_dir_all(directory);
    }
}
