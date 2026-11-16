//! Bounded atlas for the opt-in iOS GPU renderer and parity story.
//!
//! Geometry and mark rasterization stay here so Metal only combines immutable
//! per-hold fields. The binary is a little-endian JSON-length, a JSON manifest,
//! then byte-addressed pixel storage. Offsets in the manifest address storage.
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::collections::HashSet;
use tiny_skia::{FillRule, Mask, Paint, PathBuilder, Pixmap, Stroke, Transform};

use super::{clamp_multiplier, effective_mark_style, geometry::LitHold, glow, marks};
use crate::edt::{NO_DISTANCE, NO_SITE, labelled_edt};
use crate::types::{
    BoardRenderMode, Color, GlyphMode, HoldRenderStyle, HoldRole, MarkStyle, RenderConfig,
};

// Editing expands the sampled falloff; immutable fields reserve its full reach.
use super::gpu_constants::{EDIT_PEAK_REACH, MAX_GPU_BYTES as MAX_BYTES};

fn append(storage: &mut Vec<u8>, bytes: &[u8]) -> Result<usize, String> {
    if storage.len().saturating_add(bytes.len()) > MAX_BYTES {
        return Err("GPU atlas exceeds 128 MiB budget".into());
    }
    let offset = storage.len();
    storage.extend_from_slice(bytes);
    Ok(offset)
}

/// A stamp's rectangle is in absolute board pixels; absent stamps cost no bytes.
fn append_stamp(
    storage: &mut Vec<u8>,
    stamp: &Pixmap,
    origin_x: u32,
    origin_y: u32,
) -> Result<Value, String> {
    append_stamp_region(
        storage,
        stamp,
        origin_x,
        origin_y,
        [0, 0, stamp.width(), stamp.height()],
    )
}

fn append_stamp_region(
    storage: &mut Vec<u8>,
    stamp: &Pixmap,
    origin_x: u32,
    origin_y: u32,
    search: [u32; 4],
) -> Result<Value, String> {
    let mut left = stamp.width();
    let mut top = stamp.height();
    let mut right = 0;
    let mut bottom = 0;
    for y in search[1]..search[3] {
        for x in search[0]..search[2] {
            if stamp.data()[((y * stamp.width() + x) * 4 + 3) as usize] != 0 {
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
            }
        }
    }
    if right <= left || bottom <= top {
        return Ok(Value::Null);
    }
    let needed = (right - left) as usize * (bottom - top) as usize * 4;
    if storage.len().saturating_add(needed) > MAX_BYTES {
        return Err("GPU atlas exceeds 128 MiB budget".into());
    }
    let offset = storage.len();
    for y in top..bottom {
        let start = ((y * stamp.width() + left) * 4) as usize;
        storage.extend_from_slice(&stamp.data()[start..start + (right - left) as usize * 4]);
    }
    Ok(
        json!({"offset":offset,"x":origin_x+left,"y":origin_y+top,"width":right-left,"height":bottom-top}),
    )
}

/// Only pixels inside this pass's extraction rectangle can be observed.
fn clear_stamp_region(stamp: &mut Pixmap, search: [u32; 4]) {
    let stride = stamp.width() as usize * 4;
    for row in search[1]..search[3] {
        let start = row as usize * stride + search[0] as usize * 4;
        let end = row as usize * stride + search[2] as usize * 4;
        stamp.data_mut()[start..end].fill(0);
    }
}

/// The 24-bit sentinel cannot alias a valid field on a 1536 × 2304 board.
pub const PACKED_NO_DISTANCE: u32 = 0x00ff_ffff;
pub fn pack_field(distance: u32, coverage: u8) -> Result<u32, String> {
    let packed_distance = if distance == NO_DISTANCE {
        PACKED_NO_DISTANCE
    } else {
        if distance >= PACKED_NO_DISTANCE {
            return Err("Squared distance exceeds exact 24-bit field".into());
        }
        distance
    };
    Ok(packed_distance | (u32::from(coverage) << 24))
}

pub struct PreparedAtlas {
    pub manifest: Vec<u8>,
    pub pixels: Vec<u8>,
}

pub fn prepare(config: &RenderConfig) -> Result<Vec<u8>, String> {
    let atlas = prepare_owned(config)?;
    let mut result = Vec::with_capacity(4 + atlas.manifest.len() + atlas.pixels.len());
    result.extend_from_slice(&(atlas.manifest.len() as u32).to_le_bytes());
    result.extend_from_slice(&atlas.manifest);
    result.extend_from_slice(&atlas.pixels);
    Ok(result)
}

fn translated(mut hold: LitHold, x: f32, y: f32) -> Result<LitHold, String> {
    let transform = Transform::from_translate(-x, -y);
    hold.path = hold
        .path
        .transform(transform)
        .ok_or("Invalid hold transform")?;
    hold.base_path = hold.base_path.and_then(|path| path.transform(transform));
    hold.cx -= x;
    hold.cy -= y;
    Ok(hold)
}

pub fn prepare_owned(config: &RenderConfig) -> Result<PreparedAtlas, String> {
    prepare_internal(config, None)
}

pub(super) fn prepare_internal(
    config: &RenderConfig,
    prebuilt: Option<&super::gpu_geometry::GeometryReader>,
) -> Result<PreparedAtlas, String> {
    prepare_subset(config, prebuilt, None)
}

/// Selection changes work performed, never layout-dependent crop/cap semantics.
/// A field and a role's stamps are independently cacheable immutable chunks.
#[derive(Default)]
pub(super) struct AtlasSelection {
    pub fields: HashSet<u32>,
    pub roles: HashMap<u32, HashSet<u32>>,
    pub covers: bool,
    pub describe: bool,
}

pub(super) fn prepare_subset(
    config: &RenderConfig,
    prebuilt: Option<&super::gpu_geometry::GeometryReader>,
    selection: Option<&AtlasSelection>,
) -> Result<PreparedAtlas, String> {
    prepare_subset_checked(config, prebuilt, selection, &|| Ok(()))
}

pub(super) fn prepare_subset_checked(
    config: &RenderConfig,
    prebuilt: Option<&super::gpu_geometry::GeometryReader>,
    selection: Option<&AtlasSelection>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<PreparedAtlas, String> {
    let _work = super::gpu_packet_stats::preparation();
    check()?;
    let (width, height) = crate::renderer::output_size(config)?;
    if config.render_mode != BoardRenderMode::Aura
        || width > 1536
        || height > 2304
        || config.holds.len() > 1024
        || config.hold_state_map.len() > 32
    {
        return Err("Unsupported GPU prototype layout".into());
    }
    let tuning = &config.glow;
    if tuning.disc_opacity != 0.0
        || tuning.spill_boost != 0.0
        || tuning.dither != 0.0
        || tuning.rim_width_fraction != 0.0
        || tuning.core_whiten != 0.0
        || tuning.falloff_gamma != 1.0
    {
        return Err("Unsupported GPU prototype treatment".into());
    }
    let scale_x = width as f32 / config.board_width;
    let scale_y = height as f32 / config.board_height;
    let mark = effective_mark_style(config);
    if matches!(mark, MarkStyle::Fill | MarkStyle::GlowFill) {
        return Err("Filled Aura requires the exact PNG compositor".into());
    }
    let draws_glow = matches!(
        mark,
        MarkStyle::Glow | MarkStyle::GlowFill | MarkStyle::Outline
    );
    let draws_plate = config.led_base.opacity.is_finite()
        && config.led_base.opacity > 0.0
        && mark != MarkStyle::NoMark;
    let outline_cap = if mark == MarkStyle::Outline {
        super::geometry::median_hold_radius_px(&config.holds, scale_x)
    } else {
        None
    };
    let geometry: Vec<_> = config
        .holds
        .iter()
        .enumerate()
        .filter_map(|(index, hold)| {
            let lit = LitHold::new(
                hold,
                HoldRole::Hand,
                Color {
                    r: 255,
                    g: 255,
                    b: 255,
                },
                scale_x,
                scale_y,
            )?;
            let mut reach = lit.reach_px(tuning, clamp_multiplier(config.shape_size_multiplier));
            if let Some(cap) = outline_cap
                && lit.r_px > cap
            {
                reach *= cap / lit.r_px;
            }
            Some((index, hold, lit, reach))
        })
        .collect();
    let max_reach = geometry
        .iter()
        .map(|(_, _, _, reach)| *reach)
        .fold(0.0_f32, f32::max);
    if !max_reach.is_finite() || max_reach > 512.0 {
        return Err("Unsupported GPU glow reach".into());
    }
    let padding = (max_reach * EDIT_PEAK_REACH).ceil() + 2.0;
    let mut storage = Vec::new();
    let paint_covers = selection.is_none_or(|selection| selection.covers);
    let paint_roles = selection.is_none_or(|selection| !selection.roles.is_empty());
    let mut covers = Pixmap::new(
        if paint_covers || paint_roles {
            width
        } else {
            1
        },
        if paint_covers || paint_roles {
            height
        } else {
            1
        },
    )
    .ok_or("Cover allocation failed")?;
    if paint_covers && let Some(cover) = &config.led_cover {
        marks::paint_led_covers(&mut covers, &config.holds, scale_x, scale_y, cover);
    }
    let covers_offset = append_stamp(&mut storage, &covers, 0, 0)?;
    // Stamp paths stay in board coordinates. Translating a curved path before
    // stroking changes tiny-skia's edge pixels on small glyphs and outlines.
    let mut stamp_canvas = covers;
    stamp_canvas.fill(tiny_skia::Color::TRANSPARENT);
    let mut veil = Pixmap::new(1, 1).ok_or("Veil allocation failed")?;
    if let Some(settings) = &config.veil {
        marks::paint_veil(&mut veil, settings, &[]);
    }
    let mut entries = Vec::new();
    let mut states: Vec<_> = config.hold_state_map.iter().collect();
    states.sort_by_key(|(code, _)| **code);
    for (source_index, source, lit, reach) in geometry {
        check()?;
        if selection.is_some_and(|selection| {
            !selection.describe
                && !selection.fields.contains(&source.id)
                && !selection.roles.contains_key(&source.id)
        }) {
            continue;
        }
        let bounds = lit.bounds();
        let x = (bounds.left() - padding).floor().clamp(0.0, width as f32) as u32;
        let y = (bounds.top() - padding).floor().clamp(0.0, height as f32) as u32;
        let right = (bounds.right() + padding).ceil().clamp(0.0, width as f32) as u32;
        let bottom = (bounds.bottom() + padding).ceil().clamp(0.0, height as f32) as u32;
        if right <= x || bottom <= y {
            continue;
        }
        let crop_width = right - x;
        let crop_height = bottom - y;
        let pixels = crop_width as usize * crop_height as usize;
        let include_field = selection.is_none_or(|selection| selection.fields.contains(&source.id));
        // Bound all persistent bytes before allocating masks, fields or marks.
        let needed = pixels.checked_mul(4).ok_or("Atlas size overflow")?;
        if include_field && storage.len().saturating_add(needed) > MAX_BYTES {
            return Err("GPU atlas exceeds 128 MiB budget".into());
        }
        let original_bounds = [bounds.left(), bounds.top(), bounds.right(), bounds.bottom()];
        let local = translated(lit, x as f32, y as f32)?;
        let field_offset = storage.len();
        if !include_field {
            // Annotation and stamp-only chunks never allocate an unused EDT.
        } else if let Some(prebuilt) = prebuilt {
            let field = prebuilt.field(config, source, x, y, crop_width, crop_height)?;
            append(&mut storage, &field)?;
        } else {
            let field = field_pixels(config, &local, crop_width, crop_height, draws_plate)?;
            append(&mut storage, &field)?;
        }
        let mut role_entries = Vec::new();
        let mut role_stamps: HashMap<String, u32> = HashMap::new();
        for (code, state) in &states {
            check()?;
            if selection.is_some_and(|selection| {
                selection
                    .roles
                    .get(&source.id)
                    .is_none_or(|roles| !roles.contains(code))
            }) {
                continue;
            }
            let Some(color) = Color::from_hex(&state.color) else {
                continue;
            };
            let stamp_key = format!(
                "{:?}:{:?}:{}:{}:{}",
                state.role, state.render_style, color.r, color.g, color.b
            );
            if let Some(canonical) = role_stamps.get(&stamp_key) {
                // The pixels and visual identity already belong to an earlier
                // full row. Keep only this state's lookup alias in the manifest.
                role_entries.push(json!({"state":code,"alias":canonical}));
                continue;
            }
            let annotation = state.render_style == HoldRenderStyle::AboveMarker;
            let draws_fill = !annotation && mark == MarkStyle::Outline;
            let draws_glyph = !annotation && config.glyphs == GlyphMode::Role;
            let Some(role_hold) = LitHold::new(source, state.role, color, scale_x, scale_y) else {
                continue;
            };
            let draws_role_plate = !annotation && draws_plate && role_hold.base_path.is_some();
            let raster_role = draws_fill || draws_role_plate || draws_glyph || annotation;
            if raster_role {
                super::gpu_packet_stats::role_attempt();
            }
            let edge_scale = clamp_multiplier(config.stroke_width_multiplier);
            let mut fill_offset = Value::Null;
            let mut plate_offset = Value::Null;
            let mut glyph_offset = Value::Null;
            let mut fill_passes = vec![Value::Null; 4];
            let mut glyph_passes = vec![Value::Null; 2];
            if draws_fill || draws_role_plate || draws_glyph {
                let stamp = &mut stamp_canvas;
                let edge_padding = (marks::OUTLINE_WIDTH_FRACTION
                    * role_hold.r_px
                    * edge_scale
                    * 0.5)
                    .max(config.fill.outer_edge_width_fraction * role_hold.r_px * edge_scale * 0.5)
                    .max(1.0)
                    + 2.0;
                let stamp_bounds = role_hold.bounds();
                let search = [
                    (stamp_bounds.left() - edge_padding)
                        .floor()
                        .clamp(0.0, width as f32) as u32,
                    (stamp_bounds.top() - edge_padding)
                        .floor()
                        .clamp(0.0, height as f32) as u32,
                    (stamp_bounds.right() + edge_padding)
                        .ceil()
                        .clamp(0.0, width as f32) as u32,
                    (stamp_bounds.bottom() + edge_padding)
                        .ceil()
                        .clamp(0.0, height as f32) as u32,
                ];
                clear_stamp_region(stamp, search);
                if draws_fill {
                    marks::paint_outline(
                        stamp,
                        std::slice::from_ref(&role_hold),
                        &config.fill,
                        edge_scale,
                    );
                    fill_passes[0] = append_stamp_region(&mut storage, stamp, 0, 0, search)?;
                    fill_offset = fill_passes[0].clone();
                    clear_stamp_region(stamp, search);
                }
                if draws_role_plate {
                    marks::paint_led_base(
                        stamp,
                        std::slice::from_ref(&role_hold),
                        &config.led_base,
                    );
                    plate_offset = append_stamp_region(&mut storage, stamp, 0, 0, search)?;
                    clear_stamp_region(stamp, search);
                }
                if draws_glyph {
                    for (pass, entry) in glyph_passes.iter_mut().enumerate() {
                        check()?;
                        clear_stamp_region(stamp, search);
                        marks::paint_glyph_pass(
                            stamp,
                            std::slice::from_ref(&role_hold),
                            &config.glyph,
                            edge_scale,
                            pass,
                        );
                        *entry = append_stamp_region(&mut storage, stamp, 0, 0, search)?;
                    }
                    glyph_offset = glyph_passes[0].clone();
                }
            }
            if annotation {
                for (pass, entry) in glyph_passes.iter_mut().enumerate() {
                    check()?;
                    *entry = append_annotation(
                        &mut storage,
                        &mut stamp_canvas,
                        source,
                        color,
                        config,
                        [scale_x, scale_y],
                        pass,
                    )?;
                }
                glyph_offset = glyph_passes[0].clone();
            }
            if raster_role {
                super::gpu_packet_stats::role_completed();
            }
            let entry = json!({"state":code,"identity":code,"color":[color.r,color.g,color.b],"fill":fill_offset,"plate":plate_offset,"glyph":glyph_offset,"annotation":annotation,"fillPasses":fill_passes,"glyphPasses":glyph_passes});
            role_stamps.insert(stamp_key, **code);
            role_entries.push(entry);
        }
        let mut entry = json!({"id":source.id,"mirror":source.mirrored_hold_id,"x":x,"y":y,
            "width":crop_width,"height":crop_height,"bounds":original_bounds,
            "field":field_offset,"reach":reach,"roles":role_entries});
        if selection.is_some_and(|selection| selection.describe) {
            entry["sourceIndex"] = json!(source_index);
        }
        entries.push(entry);
    }
    let lut = glow::FalloffLut::from_stops(&glow::falloff_stops(
        config.glow_falloff,
        tuning.plateau_share,
    ));
    let manifest = json!({"version":2,"width":width,"height":height,"covers":covers_offset,
        "veil":veil.data(),"mirrored":config.mirrored,"glow":draws_glow,
        "merge":tuning.merge_softness.clamp(0.0,1.0),"seam":tuning.seam_blend_fraction.clamp(0.0,1.0),
        "seamMix":tuning.seam_max_mix.clamp(0.0,0.5),"seamSharpness":tuning.seam_sharpness.clamp(1.0,8.0),
        "fringe":tuning.fringe_deepen.clamp(0.0,1.0),"coreShare":tuning.core_share.clamp(0.02,1.0),
        "lut":(0..257).map(|index|lut.at(index as f32/256.0)).collect::<Vec<_>>(),"holds":entries});
    let manifest = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    if storage.is_empty() {
        storage.resize(4, 0);
    }
    Ok(PreparedAtlas {
        manifest,
        pixels: storage,
    })
}

pub(super) fn field_pixels(
    config: &RenderConfig,
    local: &LitHold,
    width: u32,
    height: u32,
    draws_plate: bool,
) -> Result<Vec<u8>, String> {
    super::gpu_packet_stats::field_attempt();
    let mut coverage = Mask::new(width, height).ok_or("Mask allocation failed")?;
    coverage.fill_path(&local.path, FillRule::Winding, true, Transform::identity());
    let mut sites_mask = coverage.clone();
    if draws_plate
        && config.led_base.glow_from_base
        && let Some(plate) = &local.base_path
    {
        sites_mask.clear();
        sites_mask.fill_path(plate, FillRule::EvenOdd, true, Transform::identity());
    }
    let sites: Vec<_> = sites_mask
        .data()
        .iter()
        .zip(coverage.data())
        .map(|(site, silhouette)| {
            if *site >= 128 && *silhouette >= 128 {
                1
            } else {
                NO_SITE
            }
        })
        .collect();
    let field = labelled_edt(width as usize, height as usize, &sites);
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for (distance, coverage) in field.dist2.iter().zip(coverage.data()) {
        pixels.extend_from_slice(&pack_field(*distance, *coverage)?.to_le_bytes());
    }
    super::gpu_packet_stats::field_completed();
    Ok(pixels)
}

fn append_annotation(
    storage: &mut Vec<u8>,
    stamp: &mut Pixmap,
    hold: &crate::types::HoldData,
    color: Color,
    config: &RenderConfig,
    scale: [f32; 2],
    pass: usize,
) -> Result<Value, String> {
    let [scale_x, scale_y] = scale;
    let (width, height) = crate::renderer::output_size(config)?;
    let radius = hold.r * scale_x;
    let marker_radius = (radius * if config.thumbnail { 0.62 } else { 0.48 }).max(2.0);
    let cx = hold.cx * scale_x;
    let cy = hold.cy * scale_y - radius * if config.thumbnail { 1.28 } else { 1.15 };
    let stroke_width = (if config.thumbnail { 8.0 } else { 6.0 })
        * scale_x
        * clamp_multiplier(config.stroke_width_multiplier);
    let stroke = (stroke_width * 0.45).max(2.0);
    let padding = marker_radius + stroke / 2.0 + 1.0;
    let left = (cx - padding).floor().clamp(0.0, width as f32) as u32;
    let top = (cy - padding).floor().clamp(0.0, height as f32) as u32;
    let right = (cx + padding).ceil().clamp(0.0, width as f32) as u32;
    let bottom = (cy + padding).ceil().clamp(0.0, height as f32) as u32;
    if right <= left || bottom <= top {
        return Ok(Value::Null);
    }
    let Some(path) = PathBuilder::from_circle(cx, cy, marker_radius) else {
        return Ok(Value::Null);
    };
    clear_stamp_region(stamp, [left, top, right, bottom]);
    let paint = Paint {
        anti_alias: true,
        shader: tiny_skia::Shader::SolidColor(tiny_skia::Color::from_rgba8(
            color.r, color.g, color.b, 255,
        )),
        ..Paint::default()
    };
    if pass == 0 {
        stamp.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
    if pass == 1 {
        stamp.stroke_path(
            &path,
            &paint,
            &Stroke {
                width: stroke,
                ..Stroke::default()
            },
            Transform::identity(),
            None,
        );
    }
    append_stamp_region(storage, stamp, 0, 0, [left, top, right, bottom])
}

pub fn prepare_with_geometry(
    config: &RenderConfig,
    path: &std::path::Path,
) -> Result<PreparedAtlas, String> {
    let geometry = super::gpu_geometry::GeometryReader::open(path)?;
    prepare_internal(config, Some(&geometry))
}

/// Geometry-only key, shared across themes, roles, colours and animation frames.
pub fn geometry_cache_key(config: &RenderConfig) -> String {
    let glow = &config.glow;
    let mut holds: Vec<_> = config
        .holds
        .iter()
        .map(|hold| super::gpu_geometry::hold_identity(config, hold))
        .collect();
    holds.sort();
    super::gpu_geometry::sha256(
        &serde_json::to_vec(&json!([
            "aura-field-v2-edt1",
            holds,
            config.shape_size_multiplier,
            effective_mark_style(config) == MarkStyle::Outline,
            glow.spread_fraction,
            glow.hold_extent_cap,
            glow.size_floor_fraction,
            glow.small_hold_max_boost,
            glow.reach_scale
        ]))
        .expect("geometry key serializes"),
    )
}

/// Optional acceleration never changes the outcome of local preparation.
/// A late download has no effect on this invocation's selected input.
pub fn prepare_cached(
    config: &RenderConfig,
    prebuilt: Option<(&std::path::Path, &str)>,
    generated_dir: Option<&std::path::Path>,
) -> Result<PreparedAtlas, String> {
    let generated_dir = generated_dir.filter(|directory| prune_generated(directory, 0, 0).is_ok());
    if let Some((path, expected_sha)) = prebuilt
        && let Ok(reader) = super::gpu_geometry::GeometryReader::open_verified(path, expected_sha)
        && let Ok(atlas) = prepare_internal(config, Some(&reader))
    {
        return Ok(atlas);
    }
    let key = geometry_cache_key(config);
    if let Some(directory) = generated_dir
        && let Ok(entries) = std::fs::read_dir(directory)
    {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(hash) = name
                .strip_prefix(&format!("{key}-"))
                .and_then(|name| name.strip_suffix(".aura"))
                && let Ok(reader) =
                    super::gpu_geometry::GeometryReader::open_verified(&entry.path(), hash)
                && let Ok(atlas) = prepare_internal(config, Some(&reader))
            {
                return Ok(atlas);
            }
        }
    }
    let atlas = prepare_owned(config)?;
    if let Some(directory) = generated_dir {
        // Disk full, permission failures and cache eviction never fail rendering.
        if let Ok(bytes) = super::gpu_geometry::encode(config, &atlas) {
            let _ = publish_generated(directory, &key, &bytes);
        }
    }
    Ok(atlas)
}

pub fn verify_geometry_file(path: &std::path::Path, expected_sha: &str) -> Result<(), String> {
    verified_geometry_file(path, expected_sha).map(|_| ())
}

pub(super) fn verified_geometry_file(
    path: &std::path::Path,
    expected_sha: &str,
) -> Result<std::fs::File, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    if expected_sha.len() != 64 || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid geometry checksum".into());
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length > 256 * 1024 * 1024 {
        return Err("Geometry file exceeds 256 MiB".into());
    }
    let mut buffer = [0_u8; 65536];
    let mut digest = Sha256::new();
    let mut read_bytes = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        read_bytes += count as u64;
        if read_bytes > length {
            return Err("Geometry file changed while reading".into());
        }
        digest.update(&buffer[..count]);
    }
    if read_bytes != length || format!("{:x}", digest.finalize()) != expected_sha {
        return Err("Geometry checksum mismatch".into());
    }
    Ok(file)
}

fn prune_generated(
    directory: &std::path::Path,
    incoming_bytes: u64,
    incoming_entries: usize,
) -> Result<(), String> {
    const LIMIT: u64 = 256 * 1024 * 1024;
    if incoming_bytes > LIMIT {
        return Err("Generated geometry exceeds disk budget".into());
    }
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let preferred_path = directory.join(".offline-scopes.json");
    let preferred: Vec<String> = std::fs::metadata(&preferred_path)
        .ok()
        .filter(|metadata| metadata.len() <= 65536)
        .and_then(|_| std::fs::read(&preferred_path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "part")
        {
            std::fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            continue;
        }
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "aura")
        {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            continue;
        }
        let scope = super::gpu_geometry::GeometryReader::open(&entry.path())
            .ok()
            .and_then(|reader| reader.scope().map(str::to_owned));
        total = total.saturating_add(metadata.len());
        entries.push((
            scope.is_some_and(|scope| preferred.contains(&scope)),
            metadata.modified().ok(),
            entry.path(),
            metadata.len(),
        ));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let mut count = entries.len();
    for (_, _, path, length) in entries {
        if count.saturating_add(incoming_entries) <= 4
            && total.saturating_add(incoming_bytes) <= LIMIT
        {
            break;
        }
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
        count -= 1;
        total -= length;
    }
    if count.saturating_add(incoming_entries) > 4 || total.saturating_add(incoming_bytes) > LIMIT {
        return Err("Generated cache budget unavailable".into());
    }
    Ok(())
}

fn publish_generated(directory: &std::path::Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    prune_generated(directory, bytes.len() as u64, 1)?;
    let name = format!("{key}-{}.aura", super::gpu_geometry::sha256(bytes));
    let destination = directory.join(name);
    let partial = directory.join(format!(".{key}.{}.part", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&partial, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cropped_real_glyph_reconstructs_the_global_raster_without_pixel_changes() {
        let config: RenderConfig =
            serde_json::from_str(include_str!("fixtures/decoy-foot-glyph.json")).unwrap();
        let atlas = prepare_owned(&config).unwrap();
        let manifest: Value = serde_json::from_slice(&atlas.manifest).unwrap();
        let (reference, width, height) = super::super::render(&config).unwrap();
        assert_eq!(
            &reference[(324 * width as usize + 380) * 4..(324 * width as usize + 380) * 4 + 4],
            &[243, 243, 243, 253]
        );
        for (pass, stamp) in manifest["holds"][0]["roles"][0]["glyphPasses"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let number = |name: &str| stamp[name].as_u64().unwrap() as usize;
            let mut reconstructed = vec![0; reference.len()];
            for row in 0..number("height") {
                let source = number("offset") + row * number("width") * 4;
                let target = ((number("y") + row) * width as usize + number("x")) * 4;
                reconstructed[target..target + number("width") * 4]
                    .copy_from_slice(&atlas.pixels[source..source + number("width") * 4]);
            }
            let mut direct = Pixmap::new(width, height).unwrap();
            let hold = LitHold::new(
                &config.holds[0],
                HoldRole::Foot,
                Color {
                    r: 255,
                    g: 0,
                    b: 255,
                },
                1.0,
                1.0,
            )
            .unwrap();
            marks::paint_glyph_pass(&mut direct, &[hold], &config.glyph, 1.0, pass);
            assert_eq!(
                reconstructed,
                direct.data(),
                "Each pass must rasterize before cropping"
            );
        }
    }
    #[test]
    fn generated_cache_admission_obeys_bytes_entries_and_offline_preference() {
        let directory =
            std::env::temp_dir().join(format!("aura-generated-budget-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(".offline-scopes.json"), b"[\"offline\"]").unwrap();
        let mut config = config();
        let mut preferred_key = String::new();
        for index in 0..6 {
            config.holds[0].r = 10.0 + index as f32;
            config.geometry_cache_scope = Some(if index == 0 {
                "offline".to_owned()
            } else {
                format!("online-{index}")
            });
            let key = geometry_cache_key(&config);
            if index == 0 {
                preferred_key = key.clone();
            }
            let atlas = prepare_owned(&config).unwrap();
            let bytes = super::super::gpu_geometry::encode(&config, &atlas).unwrap();
            publish_generated(&directory, &key, &bytes).unwrap();
            let stored: Vec<_> = std::fs::read_dir(&directory)
                .unwrap()
                .flatten()
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "aura")
                })
                .collect();
            assert!(stored.len() <= 4);
            assert!(
                stored
                    .iter()
                    .map(|entry| entry.metadata().unwrap().len())
                    .sum::<u64>()
                    <= 256 * 1024 * 1024
            );
            assert!(stored.iter().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&preferred_key)
            }));
        }
        for entry in std::fs::read_dir(&directory).unwrap().flatten() {
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "aura")
            {
                std::fs::remove_file(entry.path()).unwrap();
            }
        }
        for index in 0..3 {
            std::fs::File::create(directory.join(format!("oversized-{index}.aura")))
                .unwrap()
                .set_len(100 * 1024 * 1024)
                .unwrap();
        }
        let local = prepare_owned(&config).unwrap();
        assert_eq!(
            prepare_cached(&config, None, Some(&directory))
                .unwrap()
                .pixels,
            local.pixels
        );
        let stored: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "aura")
            })
            .collect();
        assert!(
            stored
                .iter()
                .map(|entry| entry.metadata().unwrap().len())
                .sum::<u64>()
                <= 256 * 1024 * 1024
        );
        std::fs::create_dir(directory.join("undeletable.part")).unwrap();
        let before = std::fs::read_dir(&directory).unwrap().count();
        config.holds[0].r += 1.0;
        assert_eq!(
            prepare_cached(&config, None, Some(&directory))
                .unwrap()
                .pixels,
            prepare_owned(&config).unwrap().pixels
        );
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            before,
            "Failed staging cleanup disables writes"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
    fn config() -> RenderConfig {
        serde_json::from_value(
            json!({"board_width":100,"board_height":100,"output_width":100,
            "frames":"p1r42","thumbnail":false,"render_mode":"aura",
            "holds":[{"id":1,"cx":50,"cy":50,"r":10}],
            "hold_state_map":{"42":{"color":"#00FF00"}}}),
        )
        .unwrap()
    }
    #[test]
    fn atlas_is_independent_of_the_active_climb() {
        let mut config = config();
        let first = prepare(&config).unwrap();
        config.frames.clear();
        assert_eq!(first, prepare(&config).unwrap());
    }
    #[test]
    fn equivalent_role_aliases_share_visual_identity_without_merging_different_roles() {
        let mut config = config();
        config.hold_state_map.get_mut(&42).unwrap().role = HoldRole::Hand;
        let hand = config.hold_state_map[&42].clone();
        config.hold_state_map.insert(13, hand.clone());
        config.hold_state_map.insert(43, hand);
        let mut finish = config.hold_state_map[&42].clone();
        finish.role = HoldRole::Finish;
        config.hold_state_map.insert(44, finish);
        let atlas = prepare_owned(&config).unwrap();
        let manifest: Value = serde_json::from_slice(&atlas.manifest).unwrap();
        let roles = manifest["holds"][0]["roles"].as_array().unwrap();
        assert_eq!(
            roles
                .iter()
                .map(|role| role["state"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![13, 42, 43, 44]
        );
        assert_eq!(roles[0]["identity"], 13);
        assert_eq!(roles[1], json!({"state":42,"alias":13}));
        assert_eq!(roles[2], json!({"state":43,"alias":13}));
        assert_eq!(roles[3]["identity"], 44);
        assert!(roles[0].get("alias").is_none());
        assert!(roles[3].get("alias").is_none());
        // Removing equivalent lookup codes must not change any pixel or stamp.
        config.hold_state_map.remove(&42);
        config.hold_state_map.remove(&43);
        let canonical_only = prepare_owned(&config).unwrap();
        assert_eq!(atlas.pixels, canonical_only.pixels);
        let canonical_manifest: Value = serde_json::from_slice(&canonical_only.manifest).unwrap();
        let canonical_roles = canonical_manifest["holds"][0]["roles"].as_array().unwrap();
        assert_eq!(roles[0], canonical_roles[0]);
        assert_eq!(roles[3], canonical_roles[1]);
    }
    #[test]
    fn role_aliases_keep_color_and_auxiliary_style_boundaries() {
        let mut config = config();
        let hand = config.hold_state_map[&42].clone();
        config.hold_state_map.insert(13, hand.clone());
        let mut blue = hand.clone();
        blue.color = "#0000FF".into();
        config.hold_state_map.insert(44, blue);
        let mut auxiliary = hand;
        auxiliary.render_style = HoldRenderStyle::AboveMarker;
        config.hold_state_map.insert(46, auxiliary.clone());
        config.hold_state_map.insert(47, auxiliary);
        let atlas = prepare_owned(&config).unwrap();
        let manifest: Value = serde_json::from_slice(&atlas.manifest).unwrap();
        let roles = manifest["holds"][0]["roles"].as_array().unwrap();
        assert_eq!(roles[1], json!({"state":42,"alias":13}));
        assert_eq!(roles[2]["identity"], 44);
        assert_eq!(roles[2]["color"], json!([0, 0, 255]));
        assert_eq!(roles[3]["identity"], 46);
        assert_eq!(roles[3]["annotation"], true);
        assert!(
            roles[3]["glyphPasses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|stamp| !stamp.is_null())
        );
        assert_eq!(roles[4], json!({"state":47,"alias":46}));
        config.hold_state_map.remove(&42);
        config.hold_state_map.remove(&47);
        assert_eq!(atlas.pixels, prepare_owned(&config).unwrap().pixels);
    }
    #[test]
    fn dimensions_and_unsupported_treatments_are_bounded() {
        let mut config = config();
        config.output_width = 1537;
        assert!(prepare(&config).is_err());
        config.output_width = 100;
        config.glow.spill_boost = 1.0;
        assert!(prepare(&config).is_err());
    }
    #[test]
    fn phone_resolution_keeps_native_width_within_the_layout_budget() {
        let mut config = config();
        config.holds.clear();
        for width in [1080, 1536] {
            config.output_width = width;
            assert!(prepare(&config).is_ok(), "supported output width {width}");
        }
        config.output_width = 100;
        config.board_height = 2305.0;
        assert!(prepare(&config).is_err(), "height remains bounded at 2304");
    }
    #[test]
    fn fields_reserve_the_full_editor_expansion_before_upload() {
        let mut config = config();
        config.board_width = 1000.0;
        config.board_height = 1000.0;
        config.output_width = 1000;
        config.holds[0].cx = 500.0;
        config.holds[0].cy = 500.0;
        let packed = prepare(&config).unwrap();
        let length = u32::from_le_bytes(packed[..4].try_into().unwrap()) as usize;
        let manifest: serde_json::Value = serde_json::from_slice(&packed[4..4 + length]).unwrap();
        let hold = &manifest["holds"][0];
        let reach = hold["reach"].as_f64().unwrap();
        let padding = (reach * 1.35).ceil() + 2.0;
        let bounds = hold["bounds"].as_array().unwrap();
        let x = hold["x"].as_f64().unwrap();
        let y = hold["y"].as_f64().unwrap();
        assert_eq!(x, (bounds[0].as_f64().unwrap() - padding).floor());
        assert_eq!(y, (bounds[1].as_f64().unwrap() - padding).floor());
        assert_eq!(
            x + hold["width"].as_f64().unwrap(),
            (bounds[2].as_f64().unwrap() + padding).ceil()
        );
        assert_eq!(
            y + hold["height"].as_f64().unwrap(),
            (bounds[3].as_f64().unwrap() + padding).ceil()
        );
        assert!(
            padding > reach.ceil() + 2.0,
            "Guard must reject normal-only padding"
        );
    }
    #[test]
    fn fields_store_exact_squared_distance_and_coverage() {
        let packed = prepare(&config()).unwrap();
        let length = u32::from_le_bytes(packed[..4].try_into().unwrap()) as usize;
        let manifest: serde_json::Value = serde_json::from_slice(&packed[4..4 + length]).unwrap();
        let hold = &manifest["holds"][0];
        let x = hold["x"].as_u64().unwrap() as usize;
        let y = hold["y"].as_u64().unwrap() as usize;
        let width = hold["width"].as_u64().unwrap() as usize;
        let offset =
            hold["field"].as_u64().unwrap() as usize + ((50 - y) * width + 50 - x) * 4 + 4 + length;
        let centre = u32::from_le_bytes(packed[offset..offset + 4].try_into().unwrap());
        assert_eq!(centre & PACKED_NO_DISTANCE, 0);
        assert_eq!(centre >> 24, 255);
        let outside = offset + 15 * 4;
        let outside = u32::from_le_bytes(packed[outside..outside + 4].try_into().unwrap());
        assert_eq!(
            outside & PACKED_NO_DISTANCE,
            36,
            "pixel 65 is six pixel centres from the circle's last seed at 59"
        );
        assert_eq!(outside >> 24, 0);
    }
    #[test]
    fn packed_sentinel_and_coverage_do_not_alias_distance_bits() {
        for distance in [0, 1, 255, 65535, 1535 * 1535 + 2303 * 2303] {
            for coverage in [0, 1, 127, 128, 254, 255] {
                let packed = pack_field(distance, coverage).unwrap();
                assert_eq!(packed & PACKED_NO_DISTANCE, distance);
                assert_eq!(packed >> 24, u32::from(coverage));
            }
        }
        assert_eq!(pack_field(NO_DISTANCE, 173).unwrap(), 0xadff_ffff);
        assert!(pack_field(PACKED_NO_DISTANCE, 0).is_err());
    }
    #[test]
    fn tight_stamps_reconstruct_all_original_pixels() {
        let mut original = Pixmap::new(17, 13).unwrap();
        for y in 3..9 {
            for x in 2..14 {
                let start = ((y * 17 + x) * 4) as usize;
                original.data_mut()[start..start + 4].copy_from_slice(&[1, 2, 3, 173]);
            }
        }
        let mut storage = Vec::new();
        let crop = append_stamp(&mut storage, &original, 7, 11).unwrap();
        assert_eq!(crop, json!({"offset":0,"x":9,"y":14,"width":12,"height":6}));
        let mut reconstructed = vec![0; 17 * 13 * 4];
        for row in 0..6 {
            for column in 0..12 {
                let source = (row * 12 + column) * 4;
                let target = ((row + 3) * 17 + column + 2) * 4;
                reconstructed[target..target + 4].copy_from_slice(&storage[source..source + 4]);
            }
        }
        assert_eq!(reconstructed, original.data());
        original.fill(tiny_skia::Color::TRANSPARENT);
        assert_eq!(
            append_stamp(&mut storage, &original, 0, 0).unwrap(),
            Value::Null
        );
        assert_eq!(storage.len(), 12 * 6 * 4);
    }
    #[test]
    fn annotations_have_independent_bounds_and_match_rust_pixels() {
        let mut config = config();
        config.board_width = 100.0;
        config.board_height = 100.0;
        config.holds[0].r = 20.0;
        config.hold_state_map.get_mut(&42).unwrap().render_style = HoldRenderStyle::AboveMarker;
        config.shape_size_multiplier = 0.5;
        config.glow.reach_scale = 0.5;
        config.stroke_width_multiplier = 2.0;
        let atlas = prepare_owned(&config).unwrap();
        let manifest: Value = serde_json::from_slice(&atlas.manifest).unwrap();
        let role = &manifest["holds"][0]["roles"][0];
        assert_eq!(role["annotation"], true);
        assert!(role["fill"].is_null());
        let mut reconstructed = vec![0; 100 * 100 * 4];
        for stamp in role["glyphPasses"].as_array().unwrap() {
            let number = |name: &str| stamp[name].as_u64().unwrap() as usize;
            for row in 0..number("height") {
                for column in 0..number("width") {
                    let source = number("offset") + (row * number("width") + column) * 4;
                    let target = ((number("y") + row) * 100 + number("x") + column) * 4;
                    let alpha = atlas.pixels[source + 3] as f32 / 255.0;
                    for channel in 0..4 {
                        reconstructed[target + channel] = (atlas.pixels[source + channel] as f32
                            + reconstructed[target + channel] as f32 * (1.0 - alpha))
                            .round()
                            .clamp(0.0, 255.0)
                            as u8;
                    }
                }
            }
        }
        let (reference, _, _) = super::super::render(&config).unwrap();
        assert!(
            reconstructed
                .iter()
                .zip(reference)
                .all(|(actual, expected)| actual.abs_diff(expected) <= 1)
        );
    }
}
