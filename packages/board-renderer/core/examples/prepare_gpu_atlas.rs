//! Host-side atlas budget check; device timings come from the native story.
use board_renderer_core::{aura::gpu_atlas, types::RenderConfig};
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Expected RenderConfig JSON path")?;
    let config: RenderConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    let started = std::time::Instant::now();
    let atlas = gpu_atlas::prepare_owned(&config)?;
    let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
    if let Some(output) = std::env::args().nth(2) {
        let mut file = std::fs::File::create(output)?;
        file.write_all(&(atlas.manifest.len() as u32).to_le_bytes())?;
        file.write_all(&atlas.manifest)?;
        file.write_all(&atlas.pixels)?;
    }
    let manifest: serde_json::Value = serde_json::from_slice(&atlas.manifest)?;
    // Requested persistent pixel and LUT buffers only. Native residency also
    // counts driver allocation rounding and view-owned dynamic resources.
    let lut_bytes = 257 * std::mem::size_of::<f32>();
    println!(
        "{}",
        serde_json::json!({
            "width":manifest["width"],"height":manifest["height"],
            "holds":manifest["holds"].as_array().map(Vec::len),
            "atlasBytes":atlas.pixels.len(),
            "manifestBytes":atlas.manifest.len(),
            "assembledGpuBytes":atlas.pixels.len()+lut_bytes,
            "descriptorBytesPerHold":224,
            "hostPrepareMs":prepare_ms
        })
    );
    Ok(())
}
