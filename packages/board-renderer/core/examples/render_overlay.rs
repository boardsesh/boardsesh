//! Dev-only CLI for the glow lab (`scripts/glow-lab.ts`): render one overlay
//! from a `RenderConfig` JSON file straight to a PNG, no FFI/WASM round-trip.
//!
//! Usage: `cargo run --release --example render_overlay -- config.json out.png`

use std::time::Instant;

use board_renderer_core::renderer::render_overlay;
use board_renderer_core::types::RenderConfig;

fn main() {
    let mut arguments = std::env::args().skip(1);
    let (Some(config_path), Some(output_path)) = (arguments.next(), arguments.next()) else {
        eprintln!("usage: render_overlay <config.json> <out.png>");
        std::process::exit(2);
    };

    let config_json = std::fs::read_to_string(&config_path)
        .unwrap_or_else(|error| panic!("read {config_path}: {error}"));
    let config: RenderConfig = serde_json::from_str(&config_json)
        .unwrap_or_else(|error| panic!("parse {config_path}: {error}"));

    let started = Instant::now();
    let (rgba, width, height) =
        render_overlay(&config).unwrap_or_else(|error| panic!("render: {error}"));
    let render_elapsed = started.elapsed();

    let pixmap = tiny_skia::Pixmap::from_vec(
        rgba,
        tiny_skia::IntSize::from_wh(width, height).expect("non-zero output size"),
    )
    .expect("pixmap from rendered RGBA");
    pixmap
        .save_png(&output_path)
        .unwrap_or_else(|error| panic!("write {output_path}: {error}"));

    println!("{output_path} {width}x{height} render {render_elapsed:?}");
}
