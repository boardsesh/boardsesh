//! Host export of the exact production packet encoder for native pixel goldens.
use board_renderer_core::aura::gpu_packet::{
    Cancellation, Placement, Placements, Plan, Session, UNIFORM_BYTES,
};
use serde_json::json;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let config = args.next().ok_or("Expected config path")?;
    let source = args.next().ok_or("Expected SourceRequest path")?;
    let directory = PathBuf::from(args.next().ok_or("Expected output directory")?);
    std::fs::create_dir_all(&directory)?;
    let started = std::time::Instant::now();
    let cancel = Cancellation::default();
    let session = Session::from_json(&std::fs::read(config)?, &cancel)?;
    let mut plan = Plan::new(
        session,
        serde_json::from_slice(&std::fs::read(source)?)?,
        &cancel,
    )?;
    let description = plan.describe();
    std::fs::write(
        directory.join("plan.json"),
        serde_json::to_vec_pretty(&description)?,
    )?;
    let prepared = plan.prepare(&[], &cancel)?;
    let mut cursor = 0_u32;
    let placements = plan
        .chunks
        .iter()
        .map(|(key, layout)| {
            let placement = Placement {
                key: key.clone(),
                offset: cursor,
                bytes: layout.bytes as u32,
            };
            cursor += layout.bytes as u32;
            placement
        })
        .collect();
    let chunks = prepared
        .chunks
        .iter()
        .map(|chunk| json!({"layout":*chunk.layout,"sourceOffset":chunk.source_offset}))
        .collect::<Vec<_>>();
    std::fs::write(
        directory.join("chunks.json"),
        serde_json::to_vec_pretty(&chunks)?,
    )?;
    std::fs::write(directory.join("pixels.bin"), &prepared.bytes)?;
    let packet = plan.encode(
        Placements {
            arena_bytes: cursor,
            chunks: placements,
        },
        &cancel,
    )?;
    let header = packet.describe();
    std::fs::write(
        directory.join("packet.json"),
        serde_json::to_vec_pretty(&header)?,
    )?;
    std::fs::write(directory.join("descriptors.bin"), &packet.descriptors)?;
    std::fs::write(directory.join("resources.bin"), &packet.resources)?;
    let width = header["width"].as_u64().ok_or("Missing width")? as f32;
    let height = header["height"].as_u64().ok_or("Missing height")? as f32;
    let (lower, upper) = if packet.present[2] {
        (0, 2)
    } else if packet.present[1] {
        (1, 0)
    } else {
        (0, 0)
    };
    for (sample, progress) in [0.0, 0.25, 0.5, 0.75, 1.0].into_iter().enumerate() {
        for (pulse_index, pulse) in [1.0, 1.175, 1.35].into_iter().enumerate() {
            for mirror in [false, true] {
                let mut bytes = [0; UNIFORM_BYTES];
                packet.encode_uniforms(
                    lower,
                    upper,
                    progress,
                    pulse,
                    [width, height],
                    true,
                    mirror,
                    &mut bytes,
                )?;
                std::fs::write(
                    directory.join(format!(
                        "uniforms-{sample}-{pulse_index}-{}.bin",
                        u32::from(mirror)
                    )),
                    bytes,
                )?;
            }
        }
    }
    println!(
        "{}",
        json!({"packet":header,"pixelBytes":prepared.bytes.len(),"hostPrepareMs":started.elapsed().as_secs_f64()*1000.0})
    );
    Ok(())
}
