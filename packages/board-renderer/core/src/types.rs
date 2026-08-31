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
    Octagon,
    // Forward-compat: a shape this binary doesn't know about (e.g. a newer JS
    // bundle running against an older native renderer) deserialises here instead
    // of failing the whole render config parse. Rendered as the default circle.
    #[serde(other)]
    Unknown,
}

/// Which drawing the overlay uses (issue #2202).
///
/// `classic` is the circle / marker-shape renderer that shipped first and is
/// byte-for-byte unchanged by the Boardsesh mode. `boardsesh` is the veil +
/// glow treatment drawn on each lit hold's traced silhouette. Anything this
/// binary does not recognise falls back to `classic`, so a newer JS bundle
/// never fails a render on an older native library.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BoardRenderMode {
    #[default]
    Classic,
    Boardsesh,
    #[serde(other)]
    Unknown,
}

/// What the Boardsesh mode draws on a lit hold.
///
/// `glow` is the outward glow off the silhouette edge (the play view's mark),
/// `glow-fill` adds the lightness-normalised role fill under it (the treatment
/// measured for thumbnails), `fill` is the fill without the glow, `none` draws
/// only the veil, LED covers and glyphs. Unset: `glow-fill` when `thumbnail`,
/// `glow` otherwise.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MarkStyle {
    Glow,
    GlowFill,
    Fill,
    #[serde(rename = "none")]
    NoMark,
    #[serde(other)]
    Unknown,
}

/// The glow's alpha curve over its reach: `soft` (variant A, the default) or
/// `plateau` (variant B, full alpha over the inner `plateau_share`).
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum GlowFalloff {
    #[default]
    Soft,
    Plateau,
    #[serde(other)]
    Unknown,
}

/// The opt-in accessibility glyphs (FOOT ring, STARTING bar, HAND bar, FINISH
/// X) drawn inside each lit silhouette. They replace the classic marker shapes;
/// `hold_state_map[].shape` is ignored in Boardsesh mode.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum GlyphMode {
    #[default]
    Off,
    Role,
    #[serde(other)]
    Unknown,
}

/// The climbing role behind a hold-state code, for the glyph vocabulary.
/// Accepts the kebab-case name or the upper-case `HOLD_STATE_MAP` name.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HoldRole {
    #[serde(alias = "STARTING")]
    Starting,
    #[serde(alias = "HAND")]
    Hand,
    #[serde(alias = "FINISH")]
    Finish,
    #[serde(alias = "FOOT")]
    Foot,
    #[default]
    #[serde(other)]
    Unknown,
}

/// A wash of the play-field colour over the unlit wall, with every lit
/// silhouette punched out. The caller computes `opacity` from the wall-vs-field
/// lightness gap (0.60 / 0.30 / 0); `<= 0` draws nothing.
#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(default)]
pub struct Veil {
    pub color: String,
    pub opacity: f32,
}

impl Default for Veil {
    fn default() -> Self {
        Self {
            color: "#181225".into(),
            opacity: 0.0,
        }
    }
}

/// The glow's geometry. Every fraction is of the hold's placement radius `r`.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(default)]
pub struct GlowTuning {
    /// Outer reach of the glow past the silhouette edge, × r.
    pub spread_fraction: f32,
    /// Reach ceiling as a multiple of the silhouette's shortest extent, so a
    /// sliver of a hold stays an outline instead of becoming a disc.
    pub hold_extent_cap: f32,
    /// A hold whose longest extent is under `size_floor_fraction × 2r` gets a
    /// bigger glow instead of a second mark.
    pub size_floor_fraction: f32,
    /// Cap on that small-hold boost.
    pub small_hold_max_boost: f32,
    /// Overall reach multiplier (the rejected "reach ×1.5" arm is 1.5 here).
    pub reach_scale: f32,
    /// For the `plateau` falloff: the share of the reach held at full alpha.
    pub plateau_share: f32,
    /// The rejected soft disc under the glow: peak alpha, 0 = off.
    pub disc_opacity: f32,
    // ------------------------------------------------------------------
    // The advanced-glow knobs. Every one of them defaults to its neutral
    // value, and at neutral the per-pixel loop is untouched: a config that
    // omits them renders byte-identically to the renderer before they
    // existed (`new_glow_fields_default_neutral` pins that).
    // ------------------------------------------------------------------
    /// Exponent shaping the falloff alpha (`alpha^gamma`). 1 = the stops
    /// as-is; >1 pulls the light in tight to the hold the way a physical
    /// source falls off. Clamped to 0.25..4.
    pub falloff_gamma: f32,
    /// Alpha-dither amplitude (0..0.25) applied per pixel with interleaved
    /// gradient noise, to break the 8-bit banding a smooth ramp shows on the
    /// veiled wall. 0 = off.
    pub dither: f32,
    /// Two-tone core: how far the colour at the silhouette edge is pulled
    /// toward white (0..1, 0 = off). Reads as a hot core without any blur.
    pub core_whiten: f32,
    /// The share of the reach over which the white core decays back to the
    /// role colour.
    pub core_share: f32,
    /// Two-tone fringe: how far the outer fringe is pulled toward a deep,
    /// hue-preserving dark of the role colour (0..1, 0 = off).
    pub fringe_deepen: f32,
    /// Neon rim: a crisp near-white stroke hugging the silhouette edge, width
    /// × r. 0 = off.
    pub rim_width_fraction: f32,
    /// Rim stroke alpha.
    pub rim_opacity: f32,
    /// How far the rim colour is pulled from the role colour toward white.
    pub rim_whiten: f32,
    /// Metaball merge: smooth-min softness between neighbouring SAME-colour
    /// glows, as a fraction of the reach (0..1, 0 = off). Neighbouring lobes
    /// fuse organically instead of meeting on a hard bisector.
    pub merge_softness: f32,
    /// Seam blend: crossfade band between neighbouring DIFFERENT-colour
    /// glows, as a fraction of the reach (0..1, 0 = off). Replaces the hard
    /// Voronoi colour seam with a gradient.
    pub seam_blend_fraction: f32,
    /// Ceiling on the seam crossfade's mix toward the neighbour's colour
    /// (0..0.5). At 0.5 the bisector is a 50/50 blend, which for some role
    /// pairs lands nearer a THIRD role's colour than either parent (HAND+FOOT
    /// midpoint reads as STARTING; worse under the CVD palettes) — capping the
    /// mix keeps every seam pixel unambiguously nearer its own hold's role.
    pub seam_max_mix: f32,
    /// Light spill: multiply glow alpha over unlit TRACED silhouettes inside
    /// the reach by `1 + spill_boost × coverage`, so nearby holds catch the
    /// light instead of being fogged uniformly. 0 = off.
    pub spill_boost: f32,
}

impl Default for GlowTuning {
    fn default() -> Self {
        Self {
            spread_fraction: 0.7,
            hold_extent_cap: 1.8,
            size_floor_fraction: 0.45,
            small_hold_max_boost: 1.7,
            reach_scale: 1.0,
            plateau_share: 0.4,
            disc_opacity: 0.0,
            falloff_gamma: 1.0,
            dither: 0.0,
            core_whiten: 0.0,
            core_share: 0.25,
            fringe_deepen: 0.0,
            rim_width_fraction: 0.0,
            rim_opacity: 0.85,
            rim_whiten: 0.65,
            merge_softness: 0.0,
            seam_blend_fraction: 0.0,
            seam_max_mix: 0.5,
            spill_boost: 0.0,
        }
    }
}

/// The role-colour fill drawn over the silhouette (`fill` and `glow-fill`).
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(default)]
pub struct FillTuning {
    /// Alpha of the role-colour fill.
    pub opacity: f32,
    /// Dark art under the fill is lifted toward this OkLab lightness first
    /// (one-way: bright art is never pushed down).
    pub normalise_target: f32,
    /// Saturated inner edge band, × r, clipped inside the silhouette.
    pub band_width_fraction: f32,
    /// Thin white outer edge, × r.
    pub outer_edge_width_fraction: f32,
    pub outer_edge_opacity: f32,
}

impl Default for FillTuning {
    fn default() -> Self {
        Self {
            opacity: 0.55,
            normalise_target: 0.588,
            band_width_fraction: 0.061,
            outer_edge_width_fraction: 0.02,
            outer_edge_opacity: 0.85,
        }
    }
}

/// The accessibility glyphs' geometry and two-pass casing.
#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(default)]
pub struct GlyphTuning {
    /// Line width × r. The catalogue gives every placement on a board the same
    /// r, so this is one line width per board, not one per hold.
    pub line_width_fraction: f32,
    /// Bar half-length before the silhouette clip, × r.
    pub reach_radii: f32,
    /// FOOT ring radius as a fraction of that reach.
    pub foot_ring_reach_fraction: f32,
    pub core_color: String,
    pub opacity: f32,
    pub casing_color: String,
    pub casing_width_factor: f32,
    pub casing_opacity: f32,
}

impl Default for GlyphTuning {
    fn default() -> Self {
        Self {
            line_width_fraction: 0.11,
            reach_radii: 1.6,
            foot_ring_reach_fraction: 0.15,
            core_color: "#FFFFFF".into(),
            opacity: 0.95,
            casing_color: "#0B0B10".into(),
            casing_width_factor: 1.9,
            casing_opacity: 0.8,
        }
    }
}

/// The LED base plate: the ring of plate between the hold's silhouette and the
/// hold proper, on the placements whose art has a traced inner boundary
/// (`HoldData::led_inner`). That ring is the part a real board lights, so it
/// can be painted in the role colour while the hold body inside it keeps its
/// art.
///
/// **PARKED — `opacity` defaults to 0, so none of this draws.** The effect went
/// out in TestFlight build 6 and the holds looked worse than build 5's plain
/// silhouettes, so the owner called it: lighting the ring was the wrong idea.
/// Everything else stays — the annotation editor, the `led_inner` overrides,
/// the extractor, the shard tables and the guards in this renderer — because
/// none of it costs anything while the paint is off, and re-enabling is one
/// default plus a native artifact rebuild.
///
/// `opacity: 0` is a real off switch, not just an invisible rim: `render()`
/// gates the paint, `interior_fill_scale` and `glow_from_base` on one
/// `draws_plate` flag, so a board whose shards DO carry `led_inner` renders
/// byte-identically to the pre-plate renderer. `the_plate_is_opt_out_and_boards_
/// without_one_are_untouched` pins that across every mark style.
///
/// Every field defaults, and a hold without a usable `led_inner` ring is drawn
/// exactly as it was before this struct existed — the whole silhouette lit —
/// so a board with no annotated plates renders unchanged either way.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(default)]
pub struct LedBaseTuning {
    /// Alpha of the role colour on the plate ring. `<= 0` draws no plate, which
    /// also restores the pre-plate fill and glow on every hold. **Defaults to
    /// 0** — see the note above. 0.92 was the shipped value in build 6.
    pub opacity: f32,
    /// The role fill's opacity inside the plate ring is scaled by this, so the
    /// hold body stays readable under the lit rim. Only applies to holds that
    /// have a plate ring; `mark-style: glow` draws no fill at all and is
    /// unaffected either way.
    pub interior_fill_scale: f32,
    /// Measure the outward glow from the plate ring rather than the whole
    /// silhouette, so the glow reads as coming off the lit rim. Identical
    /// output wherever the ring reaches the silhouette edge (the usual case);
    /// it only matters where the plate does not, and there the glow fades.
    pub glow_from_base: bool,
}

impl Default for LedBaseTuning {
    fn default() -> Self {
        Self {
            // Parked. Flip to 0.92 (and rebuild the native artifacts) to bring
            // the plate back; the other two are the values build 6 shipped and
            // are inert while this is 0.
            opacity: 0.0,
            interior_fill_scale: 0.6,
            glow_from_base: true,
        }
    }
}

/// A dark disc over every LED the board art already paints bright, so an
/// unlit hold's white pip cannot be mistaken for a mark. `None` draws nothing.
#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(default)]
pub struct LedCover {
    pub radius_fraction: f32,
    pub color: String,
    pub opacity: f32,
}

impl Default for LedCover {
    fn default() -> Self {
        Self {
            radius_fraction: 0.1,
            color: "#0B0B10".into(),
            opacity: 0.85,
        }
    }
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
    // Boardsesh mode (issue #2202). Every field defaults so a classic config —
    // and every config an older JS bundle can produce — parses unchanged.
    #[serde(default)]
    pub render_mode: BoardRenderMode,
    #[serde(default)]
    pub veil: Option<Veil>,
    #[serde(default)]
    pub mark_style: Option<MarkStyle>,
    #[serde(default)]
    pub glow_falloff: GlowFalloff,
    #[serde(default)]
    pub glow: GlowTuning,
    #[serde(default)]
    pub fill: FillTuning,
    #[serde(default)]
    pub glyphs: GlyphMode,
    #[serde(default)]
    pub glyph: GlyphTuning,
    #[serde(default)]
    pub led_cover: Option<LedCover>,
    #[serde(default)]
    pub led_base: LedBaseTuning,
}

#[derive(Deserialize, Clone, Default)]
pub struct HoldData {
    pub id: u32,
    #[serde(rename = "mirroredHoldId")]
    pub mirrored_hold_id: Option<u32>,
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
    /// The hold's traced silhouette as a flat `[x0, y0, x1, y1, …]` polygon in
    /// units of `r`, relative to `(cx, cy)`. Absent, odd-length, shorter than
    /// three points or non-finite → the hold is drawn as a circle of radius `r`.
    #[serde(default)]
    pub outline: Option<Vec<f32>>,
    /// The INNER boundary of this hold's LED base plate — the hold proper —
    /// in the same flat, implicitly-closed, `r`-relative form as `outline`.
    /// The plate ring the renderer lights is `outline` MINUS this polygon.
    ///
    /// Optional and rare: it exists only where somebody has traced the plate.
    /// Absent, malformed, or not strictly inside the silhouette's box → the
    /// whole silhouette is lit, exactly as before this field existed. It never
    /// affects whether `outline` itself is used.
    #[serde(default)]
    pub led_inner: Option<Vec<f32>>,
    /// `[dx, dy]` in units of `r` from the placement centre to the bright LED
    /// blob the board art paints for this placement. Present only where the art
    /// paints it bright — lit or not.
    #[serde(default)]
    pub led: Option<[f32; 2]>,
    /// OkLab lightness of the art inside the silhouette, for the fill's
    /// one-way white lift. Absent → no lift.
    #[serde(default)]
    pub silhouette_lightness: Option<f32>,
}

#[derive(Deserialize, Clone, Default)]
pub struct HoldStateInfo {
    pub color: String,
    #[serde(default, alias = "renderStyle")]
    pub render_style: HoldRenderStyle,
    #[serde(default)]
    pub shape: HoldMarkerShape,
    #[serde(default)]
    pub role: HoldRole,
}

pub struct ParsedHold {
    pub hold_id: u32,
    pub color: Color,
    pub render_style: HoldRenderStyle,
    pub shape: HoldMarkerShape,
    pub role: HoldRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
