use std::{fs, path::Path};

const BOARDSESH_CONTRACT_MARKERS: [&[u8]; 6] = [
    b"board_renderer_render",
    b"struct RenderConfig with 20 elements",
    b"render_mode",
    b"glow_falloff",
    b"silhouette_lightness",
    b"led_inner",
];
const STATIC_ARCHIVE_MAGIC: &[u8] = b"!<arch>\n";

struct NativeArtifact {
    label: &'static str,
    path_from_core: &'static str,
    expected_fat_slices: Option<usize>,
}

const NATIVE_ARTIFACTS: [NativeArtifact; 6] = [
    NativeArtifact {
        label: "iOS device arm64",
        path_from_core: "../../mobile/modules/board-renderer/ios/BoardRendererNative.xcframework/ios-arm64/libboard_renderer_ffi.a",
        expected_fat_slices: None,
    },
    NativeArtifact {
        label: "iOS simulator arm64 + x86_64",
        path_from_core: "../../mobile/modules/board-renderer/ios/BoardRendererNative.xcframework/ios-arm64_x86_64-simulator/libboard_renderer_ffi.a",
        expected_fat_slices: Some(2),
    },
    NativeArtifact {
        label: "Android arm64-v8a",
        path_from_core: "../../mobile/modules/board-renderer/android/src/main/jniLibs/arm64-v8a/libboard_renderer_ffi.so",
        expected_fat_slices: None,
    },
    NativeArtifact {
        label: "Android armeabi-v7a",
        path_from_core: "../../mobile/modules/board-renderer/android/src/main/jniLibs/armeabi-v7a/libboard_renderer_ffi.so",
        expected_fat_slices: None,
    },
    NativeArtifact {
        label: "Android x86",
        path_from_core: "../../mobile/modules/board-renderer/android/src/main/jniLibs/x86/libboard_renderer_ffi.so",
        expected_fat_slices: None,
    },
    NativeArtifact {
        label: "Android x86_64",
        path_from_core: "../../mobile/modules/board-renderer/android/src/main/jniLibs/x86_64/libboard_renderer_ffi.so",
        expected_fat_slices: None,
    },
];

const FAT_MAGIC: u32 = 0xcafebabe;
const FAT_MAGIC_64: u32 = 0xcafebabf;

struct MachOFatSlice<'a> {
    cpu_type: u32,
    bytes: &'a [u8],
}

fn read_big_endian_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| format!("32-bit field offset {offset} overflowed"))?;
    let field = bytes.get(offset..end).ok_or_else(|| {
        format!(
            "32-bit field at offset {offset} extends past {} bytes",
            bytes.len()
        )
    })?;
    Ok(u32::from_be_bytes(
        field.try_into().expect("four-byte range has exact length"),
    ))
}

fn read_big_endian_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| format!("64-bit field offset {offset} overflowed"))?;
    let field = bytes.get(offset..end).ok_or_else(|| {
        format!(
            "64-bit field at offset {offset} extends past {} bytes",
            bytes.len()
        )
    })?;
    Ok(u64::from_be_bytes(
        field.try_into().expect("eight-byte range has exact length"),
    ))
}

/// Parse Apple's big-endian 32- or 64-bit universal-binary header without host tools.
fn parse_macho_fat_slices(bytes: &[u8]) -> Result<Vec<MachOFatSlice<'_>>, String> {
    let magic = read_big_endian_u32(bytes, 0)?;
    let (architecture_entry_size, uses_64_bit_ranges) = match magic {
        FAT_MAGIC => (20usize, false),
        FAT_MAGIC_64 => (32usize, true),
        _ => return Err(format!("unexpected Mach-O fat magic 0x{magic:08x}")),
    };
    let architecture_count = read_big_endian_u32(bytes, 4)? as usize;
    let table_size = architecture_count
        .checked_mul(architecture_entry_size)
        .ok_or_else(|| format!("architecture table for {architecture_count} slices overflowed"))?;
    let table_end = 8usize
        .checked_add(table_size)
        .ok_or_else(|| "architecture table end overflowed".to_owned())?;
    if table_end > bytes.len() {
        return Err(format!(
            "architecture table ends at byte {table_end}, past the {}-byte artifact",
            bytes.len()
        ));
    }

    let mut slices = Vec::with_capacity(architecture_count);
    for architecture_index in 0..architecture_count {
        let entry_offset = 8 + architecture_index * architecture_entry_size;
        let cpu_type = read_big_endian_u32(bytes, entry_offset)?;
        let (slice_offset, slice_size) = if uses_64_bit_ranges {
            (
                read_big_endian_u64(bytes, entry_offset + 8)?,
                read_big_endian_u64(bytes, entry_offset + 16)?,
            )
        } else {
            (
                u64::from(read_big_endian_u32(bytes, entry_offset + 8)?),
                u64::from(read_big_endian_u32(bytes, entry_offset + 12)?),
            )
        };
        let slice_start = usize::try_from(slice_offset).map_err(|_| {
            format!("slice {architecture_index} offset {slice_offset} does not fit usize")
        })?;
        let slice_length = usize::try_from(slice_size).map_err(|_| {
            format!("slice {architecture_index} size {slice_size} does not fit usize")
        })?;
        let slice_end = slice_start
            .checked_add(slice_length)
            .ok_or_else(|| format!("slice {architecture_index} range overflowed"))?;
        let slice_bytes = bytes.get(slice_start..slice_end).ok_or_else(|| {
            format!(
                "slice {architecture_index} spans bytes {slice_start}..{slice_end}, past the {}-byte artifact",
                bytes.len()
            )
        })?;
        if slice_bytes.is_empty() {
            return Err(format!("slice {architecture_index} is empty"));
        }
        slices.push(MachOFatSlice {
            cpu_type,
            bytes: slice_bytes,
        });
    }

    Ok(slices)
}

/// Parse the members of an `ar` static library without relying on a host `ar`/`nm`
/// that may not understand object files produced by the pinned Rust LLVM version.
fn parse_static_archive_members(bytes: &[u8]) -> Result<Vec<&[u8]>, String> {
    if !bytes.starts_with(STATIC_ARCHIVE_MAGIC) {
        return Err("missing static archive magic".to_owned());
    }

    let mut members = Vec::new();
    let mut header_offset = STATIC_ARCHIVE_MAGIC.len();
    while header_offset < bytes.len() {
        let header_end = header_offset
            .checked_add(60)
            .ok_or_else(|| "archive member header offset overflowed".to_owned())?;
        let header = bytes.get(header_offset..header_end).ok_or_else(|| {
            format!(
                "archive member header at byte {header_offset} extends past {} bytes",
                bytes.len()
            )
        })?;
        if &header[58..60] != b"`\n" {
            return Err(format!(
                "archive member at byte {header_offset} has an invalid header terminator"
            ));
        }
        let size_text = std::str::from_utf8(&header[48..58])
            .map_err(|error| format!("archive member size is not UTF-8: {error}"))?
            .trim();
        let member_size = size_text
            .parse::<usize>()
            .map_err(|error| format!("archive member size `{size_text}` is invalid: {error}"))?;
        let member_end = header_end
            .checked_add(member_size)
            .ok_or_else(|| "archive member range overflowed".to_owned())?;
        let member = bytes.get(header_end..member_end).ok_or_else(|| {
            format!(
                "archive member at byte {header_offset} ends at {member_end}, past the {}-byte artifact",
                bytes.len()
            )
        })?;
        members.push(member);
        header_offset = member_end
            .checked_add(member_size % 2)
            .ok_or_else(|| "archive member padding overflowed".to_owned())?;
    }

    if members.is_empty() {
        return Err("static archive contains no members".to_owned());
    }
    Ok(members)
}

fn contains_marker(bytes: &[u8], marker: &[u8]) -> bool {
    bytes.windows(marker.len()).any(|window| window == marker)
}

fn assert_contract_markers(artifact_label: &str, artifact_path: &Path, artifact_bytes: &[u8]) {
    let contract_container = if artifact_bytes.starts_with(STATIC_ARCHIVE_MAGIC) {
        let archive_members =
            parse_static_archive_members(artifact_bytes).unwrap_or_else(|error| {
                panic!(
                    "could not parse committed {artifact_label} renderer archive at {}: {error}",
                    artifact_path.display()
                )
            });
        archive_members
            .into_iter()
            .find(|member| {
                BOARDSESH_CONTRACT_MARKERS
                    .iter()
                    .all(|marker| contains_marker(member, marker))
            })
            .unwrap_or_else(|| {
                panic!(
                    "committed {artifact_label} renderer archive at {} has no object member containing the exported render symbol and complete Boardsesh RenderConfig contract; RenderConfig field-count changes intentionally require rebuilding every committed native renderer artifact from the current Rust source",
                    artifact_path.display()
                )
            })
    } else {
        artifact_bytes
    };

    for contract_marker in BOARDSESH_CONTRACT_MARKERS {
        assert!(
            contains_marker(contract_container, contract_marker),
            "committed {artifact_label} renderer artifact at {} does not contain `{}`; RenderConfig field-count changes intentionally require rebuilding every committed native renderer artifact from the current Rust source",
            artifact_path.display(),
            String::from_utf8_lossy(contract_marker),
        );
    }
}

#[test]
fn committed_native_artifacts_embed_the_boardsesh_render_contract() {
    let core_directory = Path::new(env!("CARGO_MANIFEST_DIR"));

    for artifact in NATIVE_ARTIFACTS {
        let artifact_path = core_directory.join(artifact.path_from_core);
        let artifact_bytes = fs::read(&artifact_path).unwrap_or_else(|error| {
            panic!(
                "could not read committed {} renderer artifact at {}: {error}",
                artifact.label,
                artifact_path.display()
            )
        });

        if let Some(expected_slice_count) = artifact.expected_fat_slices {
            let slices = parse_macho_fat_slices(&artifact_bytes).unwrap_or_else(|error| {
                panic!(
                    "could not parse committed {} renderer artifact at {}: {error}",
                    artifact.label,
                    artifact_path.display()
                )
            });
            assert_eq!(
                slices.len(),
                expected_slice_count,
                "committed {} renderer artifact at {} contains {} architecture slices, expected {expected_slice_count}",
                artifact.label,
                artifact_path.display(),
                slices.len(),
            );
            for (slice_index, slice) in slices.iter().enumerate() {
                let slice_label = format!(
                    "{} architecture slice {slice_index} (CPU type 0x{:08x})",
                    artifact.label, slice.cpu_type
                );
                assert_contract_markers(&slice_label, &artifact_path, slice.bytes);
            }
        } else {
            assert_contract_markers(artifact.label, &artifact_path, &artifact_bytes);
        }
    }
}
