//! Experimental, bounded atlas for the iOS parity story. No production caller.
//!
//! Geometry and mark rasterization stay here so Metal only combines immutable
//! per-hold fields. The binary is a little-endian JSON-length, a JSON manifest,
//! then byte-addressed pixel storage. Offsets in the manifest address storage.
use serde_json::json;
use tiny_skia::{FillRule, Mask, Pixmap, Transform};

use super::{clamp_multiplier, effective_mark_style, geometry::LitHold, glow, marks};
use crate::edt::{NO_DISTANCE, NO_SITE, labelled_edt};
use crate::types::{
    BoardRenderMode, Color, GlyphMode, HoldRenderStyle, HoldRole, MarkStyle, RenderConfig,
};

const MAX_BYTES: usize = 128 * 1024 * 1024;

fn append(storage: &mut Vec<u8>, bytes: &[u8]) -> Result<usize, String> {
    if storage.len().saturating_add(bytes.len()) > MAX_BYTES {
        return Err("GPU atlas exceeds 128 MiB budget".into());
    }
    let offset = storage.len();
    storage.extend_from_slice(bytes);
    Ok(offset)
}

fn append_stamp(storage: &mut Vec<u8>, bytes: &[u8]) -> Result<usize, String> {
    if bytes.iter().all(|byte| *byte == 0) {
        return Ok(u32::MAX as usize);
    }
    append(storage, bytes)
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

pub fn prepare(config: &RenderConfig) -> Result<Vec<u8>, String> {
    let (width, height) = crate::renderer::output_size(config)?;
    if config.render_mode != BoardRenderMode::Aura
        || width > 1024
        || height > 2048
        || config.holds.len() > 1024
        || config.hold_state_map.len() > 8
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
        || config
            .hold_state_map
            .values()
            .any(|state| state.render_style != HoldRenderStyle::Circle)
    {
        return Err("Unsupported GPU prototype treatment".into());
    }
    let scale_x = width as f32 / config.board_width;
    let scale_y = height as f32 / config.board_height;
    let mark = effective_mark_style(config);
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
        .filter_map(|hold| {
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
            if let Some(cap) = outline_cap {
                if lit.r_px > cap {
                    reach *= cap / lit.r_px;
                }
            }
            Some((hold, lit, reach))
        })
        .collect();
    let max_reach = geometry
        .iter()
        .map(|(_, _, reach)| *reach)
        .fold(0.0_f32, f32::max);
    if !max_reach.is_finite() || max_reach > 512.0 {
        return Err("Unsupported GPU glow reach".into());
    }
    let padding = max_reach.ceil() + 2.0;
    let mut storage = Vec::new();
    let mut covers = Pixmap::new(width, height).ok_or("Cover allocation failed")?;
    if let Some(cover) = &config.led_cover {
        marks::paint_led_covers(&mut covers, &config.holds, scale_x, scale_y, cover);
    }
    let covers_offset = append(&mut storage, covers.data())?;
    let mut veil = Pixmap::new(1, 1).ok_or("Veil allocation failed")?;
    if let Some(settings) = &config.veil {
        marks::paint_veil(&mut veil, settings, &[]);
    }
    let mut entries = Vec::new();
    let mut states: Vec<_> = config.hold_state_map.iter().collect();
    states.sort_by_key(|(code, _)| **code);
    for (source, lit, reach) in geometry {
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
        // Bound all persistent bytes before allocating masks, fields or marks.
        let needed = pixels.checked_mul(8).ok_or("Atlas size overflow")?;
        if storage.len().saturating_add(needed) > MAX_BYTES {
            return Err("GPU atlas exceeds 128 MiB budget".into());
        }
        let original_bounds = [bounds.left(), bounds.top(), bounds.right(), bounds.bottom()];
        let local = translated(lit, x as f32, y as f32)?;
        let mut coverage = Mask::new(crop_width, crop_height).ok_or("Mask allocation failed")?;
        coverage.fill_path(&local.path, FillRule::Winding, true, Transform::identity());
        let mut sites_mask = coverage.clone();
        if draws_plate && config.led_base.glow_from_base {
            if let Some(plate) = &local.base_path {
                sites_mask.clear();
                sites_mask.fill_path(plate, FillRule::EvenOdd, true, Transform::identity());
            }
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
        let field = labelled_edt(crop_width as usize, crop_height as usize, &sites);
        let field_offset = storage.len();
        for (distance, coverage) in field.dist2.iter().zip(coverage.data()) {
            let distance = if *distance == NO_DISTANCE {
                1.0e20
            } else {
                *distance as f32
            };
            storage.extend_from_slice(&distance.to_le_bytes());
            storage.extend_from_slice(&(*coverage as f32 / 255.0).to_le_bytes());
        }
        let mut role_entries = Vec::new();
        for (code, state) in &states {
            let Some(color) = Color::from_hex(&state.color) else {
                continue;
            };
            let Some(role_hold) = LitHold::new(source, state.role, color, scale_x, scale_y) else {
                continue;
            };
            let role_hold = translated(role_hold, x as f32, y as f32)?;
            let mut stamp =
                Pixmap::new(crop_width, crop_height).ok_or("Stamp allocation failed")?;
            let edge_scale = clamp_multiplier(config.stroke_width_multiplier);
            if matches!(mark, MarkStyle::GlowFill | MarkStyle::Fill) {
                marks::paint_fill(
                    &mut stamp,
                    std::slice::from_ref(&role_hold),
                    &config.fill,
                    edge_scale,
                    if draws_plate {
                        config.led_base.interior_fill_scale
                    } else {
                        1.0
                    },
                );
            } else if mark == MarkStyle::Outline {
                marks::paint_outline(
                    &mut stamp,
                    std::slice::from_ref(&role_hold),
                    &config.fill,
                    edge_scale,
                );
            }
            let fill_offset = append_stamp(&mut storage, stamp.data())?;
            stamp.fill(tiny_skia::Color::TRANSPARENT);
            if draws_plate {
                marks::paint_led_base(
                    &mut stamp,
                    std::slice::from_ref(&role_hold),
                    &config.led_base,
                );
            }
            let plate_offset = append_stamp(&mut storage, stamp.data())?;
            stamp.fill(tiny_skia::Color::TRANSPARENT);
            if config.glyphs == GlyphMode::Role {
                marks::paint_glyphs(&mut stamp, &[role_hold], &config.glyph, edge_scale);
            }
            let glyph_offset = append_stamp(&mut storage, stamp.data())?;
            role_entries.push(json!({"state":code,"color":[color.r,color.g,color.b],"fill":fill_offset,"plate":plate_offset,"glyph":glyph_offset}));
        }
        entries.push(
            json!({"id":source.id,"mirror":source.mirrored_hold_id,"x":x,"y":y,
            "width":crop_width,"height":crop_height,"bounds":original_bounds,
            "field":field_offset,"reach":reach,"roles":role_entries}),
        );
    }
    let lut = glow::FalloffLut::from_stops(&glow::falloff_stops(
        config.glow_falloff,
        tuning.plateau_share,
    ));
    let manifest = json!({"version":1,"width":width,"height":height,"covers":covers_offset,
        "veil":veil.data(),"mirrored":config.mirrored,"glow":draws_glow,
        "merge":tuning.merge_softness.clamp(0.0,1.0),"seam":tuning.seam_blend_fraction.clamp(0.0,1.0),
        "seamMix":tuning.seam_max_mix.clamp(0.0,0.5),"seamSharpness":tuning.seam_sharpness.clamp(1.0,8.0),
        "fringe":tuning.fringe_deepen.clamp(0.0,1.0),"coreShare":tuning.core_share.clamp(0.02,1.0),
        "lut":(0..257).map(|index|lut.at(index as f32/256.0)).collect::<Vec<_>>(),"holds":entries});
    let manifest = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    let mut result = Vec::with_capacity(4 + manifest.len() + storage.len());
    result.extend_from_slice(&(manifest.len() as u32).to_le_bytes());
    result.extend_from_slice(&manifest);
    result.extend_from_slice(&storage);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn dimensions_and_unsupported_treatments_are_bounded() {
        let mut config = config();
        config.output_width = 1025;
        assert!(prepare(&config).is_err());
        config.output_width = 100;
        config.glow.spill_boost = 1.0;
        assert!(prepare(&config).is_err());
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
            hold["field"].as_u64().unwrap() as usize + ((50 - y) * width + 50 - x) * 8 + 4 + length;
        assert_eq!(
            f32::from_le_bytes(packed[offset..offset + 4].try_into().unwrap()),
            0.0
        );
        assert_eq!(
            f32::from_le_bytes(packed[offset + 4..offset + 8].try_into().unwrap()),
            1.0
        );
        let outside = offset + 15 * 8;
        assert_eq!(
            f32::from_le_bytes(packed[outside..outside + 4].try_into().unwrap()),
            36.0,
            "pixel 65 is six pixel centres from the circle's last seed at 59"
        );
        assert_eq!(
            f32::from_le_bytes(packed[outside + 4..outside + 8].try_into().unwrap()),
            0.0
        );
    }
}
