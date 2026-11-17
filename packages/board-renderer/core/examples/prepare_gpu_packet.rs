//! Host export of the exact production packet encoder for native pixel goldens.
use board_renderer_core::aura::gpu_constants::EDIT_PEAK_REACH;
use board_renderer_core::aura::gpu_packet::{
    Cancellation, Packet, Placement, Placements, Plan, Reveal, Session, SourceRequest,
    UNIFORM_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Controls {
    version: u32,
    samples: Vec<Control>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Control {
    name: String,
    lower: usize,
    upper: usize,
    progress: f32,
    pulse: f32,
    mirrored: bool,
    #[serde(default)]
    editor_all_changed: bool,
    /// Wall-swap lower-only, upper-only and (optionally, default 1) shared
    /// hold weights; absent for the wipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    swap: Option<Vec<f32>>,
}
impl Control {
    /// Only after `validate_controls`: a swap carries two or three weights.
    fn reveal(&self) -> Reveal {
        match self.swap.as_deref() {
            Some(&[lower, upper]) => Reveal::Swap {
                lower,
                upper,
                shared: 1.0,
            },
            Some(&[lower, upper, shared]) => Reveal::Swap {
                lower,
                upper,
                shared,
            },
            _ => Reveal::Wipe {
                progress: self.progress,
            },
        }
    }
}

fn validate_controls(controls: &Controls) -> Result<(), String> {
    if controls.version != 1 || controls.samples.is_empty() || controls.samples.len() > 64 {
        return Err("expected version 1 and 1..64 samples".into());
    }
    let mut names = HashSet::new();
    for sample in &controls.samples {
        if sample.name.is_empty()
            || sample.name.len() > 64
            || !sample
                .name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !names.insert(sample.name.as_str())
            || sample.lower >= 3
            || sample.upper >= 3
            || !sample.progress.is_finite()
            || !(0.0..=1.0).contains(&sample.progress)
            || !sample.pulse.is_finite()
            || !(1.0..=EDIT_PEAK_REACH).contains(&sample.pulse)
            || (sample.editor_all_changed
                && (sample.lower != 0 || sample.upper != 0 || sample.progress != 0.0))
            || sample.swap.as_ref().is_some_and(|weights| {
                sample.editor_all_changed
                    || sample.progress != 0.0
                    || !(2..=3).contains(&weights.len())
                    || weights
                        .iter()
                        .any(|weight| !weight.is_finite() || !(0.0..=1.0).contains(weight))
            })
        {
            return Err("invalid, duplicate or unsafe control".into());
        }
    }
    Ok(())
}

fn placements(plan: &Plan) -> Result<Placements, String> {
    let mut cursor = 0_u32;
    let mut chunks = Vec::with_capacity(plan.chunks.len());
    for (key, layout) in &plan.chunks {
        let bytes = u32::try_from(layout.bytes).map_err(|_| "chunk length overflow")?;
        chunks.push(Placement {
            key: key.clone(),
            offset: cursor,
            bytes,
        });
        cursor = cursor.checked_add(bytes).ok_or("placement overflow")?;
    }
    Ok(Placements {
        arena_bytes: cursor,
        chunks,
    })
}

fn write_uniform(
    packet: &Packet,
    sample: &Control,
    viewport: [f32; 2],
    directory: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = [0; UNIFORM_BYTES];
    packet.encode_uniforms(
        sample.lower,
        sample.upper,
        sample.reveal(),
        sample.pulse,
        viewport,
        true,
        sample.mirrored,
        &mut bytes,
    )?;
    std::fs::write(
        directory.join(format!("uniforms-{}.bin", sample.name)),
        bytes,
    )?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let config = args.next().ok_or("Expected config path")?;
    let source = args.next().ok_or("Expected SourceRequest path")?;
    let directory = PathBuf::from(args.next().ok_or("Expected output directory")?);
    let controls = args
        .next()
        .map(|path| -> Result<Controls, Box<dyn std::error::Error>> {
            let bytes = std::fs::read(path)?;
            if bytes.len() > 64 * 1024 {
                return Err("controls exceed 64 KiB".into());
            }
            let controls = serde_json::from_slice(&bytes)?;
            validate_controls(&controls)?;
            Ok(controls)
        })
        .transpose()?;
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    std::fs::create_dir_all(&directory)?;
    let started = std::time::Instant::now();
    let cancel = Cancellation::default();
    let session = Session::from_json(&std::fs::read(config)?, &cancel)?;
    let source_bytes = std::fs::read(source)?;
    let mut plan = Plan::new(
        session.clone(),
        serde_json::from_slice(&source_bytes)?,
        &cancel,
    )?;
    let description = plan.describe();
    std::fs::write(
        directory.join("plan.json"),
        serde_json::to_vec_pretty(&description)?,
    )?;
    let prepared = plan.prepare(&[], &cancel)?;
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
    let packet = plan.encode(placements(&plan)?, &cancel)?;
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
    if let Some(controls) = controls {
        let editor = if controls
            .samples
            .iter()
            .any(|sample| sample.editor_all_changed)
        {
            let mut source: SourceRequest = serde_json::from_slice(&source_bytes)?;
            source.edit_baseline = Some(Vec::new());
            let mut editor = Plan::new(session, source, &cancel)?;
            let resident = prepared
                .chunks
                .iter()
                .map(|chunk| chunk.layout.clone())
                .collect::<Vec<_>>();
            let missing = editor.prepare(&resident, &cancel)?;
            if !missing.chunks.is_empty() || !missing.bytes.is_empty() {
                return Err("editor variant must reuse exactly the same chunks".into());
            }
            let editor = editor.encode(placements(&editor)?, &cancel)?;
            if editor.resources != packet.resources {
                return Err("editor flags must not change tile/LUT resources".into());
            }
            std::fs::write(
                directory.join("packet-editor.json"),
                serde_json::to_vec_pretty(&editor.describe())?,
            )?;
            std::fs::write(
                directory.join("descriptors-editor.bin"),
                &editor.descriptors,
            )?;
            Some(editor)
        } else {
            None
        };
        for sample in &controls.samples {
            let selected = if sample.editor_all_changed {
                editor.as_ref().ok_or("missing editor variant")?
            } else {
                &packet
            };
            write_uniform(selected, sample, [width, height], &directory)?;
        }
        std::fs::write(
            directory.join("controls.json"),
            serde_json::to_vec_pretty(&controls)?,
        )?;
    } else {
        for (sample, progress) in [0.0, 0.25, 0.5, 0.75, 1.0].into_iter().enumerate() {
            for (pulse_index, pulse) in [1.0, 1.175, 1.35].into_iter().enumerate() {
                for mirror in [false, true] {
                    let mut bytes = [0; UNIFORM_BYTES];
                    packet.encode_uniforms(
                        lower,
                        upper,
                        Reveal::Wipe { progress },
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
    }
    println!(
        "{}",
        json!({"packet":header,"pixelBytes":prepared.bytes.len(),"hostPrepareMs":started.elapsed().as_secs_f64()*1000.0})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controls() -> Controls {
        serde_json::from_value(json!({"version":1,"samples":[{"name":"forward-0","lower":0,
            "upper":2,"progress":0,"pulse":1,"mirrored":false}]}))
        .unwrap()
    }

    #[test]
    fn names_are_bounded_unique_safe_paths() {
        for name in ["", "../pixels", "a/b", "Forward", &"a".repeat(65)] {
            let mut controls = controls();
            controls.samples[0].name = name.into();
            assert!(validate_controls(&controls).is_err());
        }
        let mut controls = controls();
        controls.samples.push(Control {
            name: "forward-0".into(),
            lower: 0,
            upper: 2,
            progress: 1.0,
            pulse: 1.0,
            mirrored: false,
            editor_all_changed: false,
            swap: None,
        });
        assert!(validate_controls(&controls).is_err());
    }

    #[test]
    fn swap_controls_need_unit_weights_and_no_wipe_progress() {
        let mut controls = controls();
        controls.samples[0].swap = Some(vec![0.4, 0.0]);
        assert!(validate_controls(&controls).is_ok());
        assert_eq!(
            controls.samples[0].reveal(),
            Reveal::Swap {
                lower: 0.4,
                upper: 0.0,
                shared: 1.0
            }
        );
        controls.samples[0].swap = Some(vec![0.4, 0.0, 0.4]);
        assert!(validate_controls(&controls).is_ok());
        assert_eq!(
            controls.samples[0].reveal(),
            Reveal::Swap {
                lower: 0.4,
                upper: 0.0,
                shared: 0.4
            }
        );
        for weights in [
            vec![f32::NAN, 0.0],
            vec![0.0, 1.5],
            vec![-0.1, 0.0],
            vec![0.4, 0.0, f32::NAN],
            vec![0.4, 0.0, 1.1],
            vec![0.4],
            vec![0.4, 0.0, 0.4, 0.4],
        ] {
            controls.samples[0].swap = Some(weights);
            assert!(validate_controls(&controls).is_err());
        }
        controls.samples[0].swap = Some(vec![0.4, 0.0]);
        controls.samples[0].progress = 0.5;
        assert!(validate_controls(&controls).is_err());
    }

    #[test]
    fn malformed_controls_and_editor_interiors_are_rejected() {
        assert!(
            serde_json::from_value::<Controls>(json!({"version":1,"samples":[],"extra":0}))
                .is_err()
        );
        let mut controls = controls();
        assert!(validate_controls(&controls).is_ok());
        controls.samples[0].editor_all_changed = true;
        assert!(validate_controls(&controls).is_err());
        controls.samples[0].upper = 0;
        assert!(validate_controls(&controls).is_ok());
        controls.samples[0].progress = 0.5;
        assert!(validate_controls(&controls).is_err());
        controls.samples[0].progress = 0.0;
        controls.samples[0].pulse = f32::NAN;
        assert!(validate_controls(&controls).is_err());
        controls.samples[0].pulse = 1.36;
        assert!(validate_controls(&controls).is_err());
    }
}
