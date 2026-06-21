use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HoldRenderStyle {
    #[default]
    Circle,
    AboveMarker,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HoldMarkerShape {
    #[default]
    Circle,
    TriangleUp,
    TriangleDown,
    Square,
    Diamond,
}

fn default_stroke_width_multiplier() -> f32 {
    1.0
}

fn default_shape_size_multiplier() -> f32 {
    1.0
}

#[derive(Deserialize)]
pub struct RenderConfig {
    pub board_width: f32,
    pub board_height: f32,
    pub output_width: u32,
    pub frames: String,
    // Mobile callers omit this — they mirror via CSS scaleX(-1) on the
    // rendered PNG to keep a single cached output per climb. Web/wasm
    // callers still pass it when they need true Rust-side mirroring.
    #[serde(default)]
    pub mirrored: bool,
    pub thumbnail: bool,
    #[serde(default = "default_stroke_width_multiplier")]
    pub stroke_width_multiplier: f32,
    #[serde(default = "default_shape_size_multiplier")]
    pub shape_size_multiplier: f32,
    pub holds: Vec<HoldData>,
    pub hold_state_map: HashMap<u32, HoldStateInfo>,
}

#[derive(Deserialize, Clone)]
pub struct HoldData {
    pub id: u32,
    #[serde(rename = "mirroredHoldId")]
    pub mirrored_hold_id: Option<u32>,
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
}

#[derive(Deserialize, Clone)]
pub struct HoldStateInfo {
    pub color: String,
    #[serde(default, alias = "renderStyle")]
    pub render_style: HoldRenderStyle,
    #[serde(default)]
    pub shape: HoldMarkerShape,
}

pub struct ParsedHold {
    pub hold_id: u32,
    pub color: Color,
    pub render_style: HoldRenderStyle,
    pub shape: HoldMarkerShape,
}

#[derive(Clone, Copy)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Color {
    pub fn from_hex(hex: &str) -> Option<Color> {
        let hex = hex.trim_start_matches('#');
        if hex.len() != 6 {
            return None;
        }
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some(Color { r, g, b })
    }
}
