//! Host-side atlas budget check; device timings come from the native story.
use board_renderer_core::{aura::gpu_atlas, types::RenderConfig};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Expected RenderConfig JSON path")?;
    let config: RenderConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    let started = std::time::Instant::now();
    let packed = gpu_atlas::prepare(&config)?;
    let header_length = u32::from_le_bytes(packed[..4].try_into()?) as usize;
    let manifest: serde_json::Value = serde_json::from_slice(&packed[4..4 + header_length])?;
    println!(
        "{}",
        serde_json::json!({
            "width":manifest["width"],"height":manifest["height"],
            "holds":manifest["holds"].as_array().map(Vec::len),
            "atlasBytes":packed.len()-4-header_length,
            "hostPrepareMs":started.elapsed().as_secs_f64()*1000.0
        })
    );
    Ok(())
}
