use crate::types::{Color, HoldStateInfo, ParsedHold};
use std::collections::HashMap;

/// Parse a frames string like "p1073r42p1090r43p1157r44" into a list of ParsedHold.
/// Only the first frame is used (before first comma delimiter).
pub fn parse_frames(frames: &str, hold_state_map: &HashMap<u32, HoldStateInfo>) -> Vec<ParsedHold> {
    // Take only the first frame (before comma)
    let first_frame = frames.split(',').next().unwrap_or("");

    first_frame
        .split('p')
        .filter(|s| !s.is_empty())
        .filter_map(|hold_data| {
            let parts: Vec<&str> = hold_data.split('r').collect();
            if parts.len() != 2 {
                return None;
            }
            let hold_id: u32 = parts[0].parse().ok()?;
            let state_code: u32 = parts[1].parse().ok()?;

            let state_info = hold_state_map.get(&state_code)?;
            let color = Color::from_hex(&state_info.color)?;

            Some(ParsedHold {
                hold_id,
                color,
                render_style: state_info.render_style,
                shape: state_info.shape,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kilter_state_map() -> HashMap<u32, HoldStateInfo> {
        let mut map = HashMap::new();
        map.insert(
            42,
            HoldStateInfo {
                color: "#00FF00".into(),
                render_style: Default::default(),
                shape: Default::default(),
            },
        );
        map.insert(
            43,
            HoldStateInfo {
                color: "#00FFFF".into(),
                render_style: Default::default(),
                shape: Default::default(),
            },
        );
        map.insert(
            44,
            HoldStateInfo {
                color: "#FF00FF".into(),
                render_style: Default::default(),
                shape: Default::default(),
            },
        );
        map.insert(
            45,
            HoldStateInfo {
                color: "#FFAA00".into(),
                render_style: Default::default(),
                shape: Default::default(),
            },
        );
        map
    }

    #[test]
    fn test_parse_simple_frames() {
        let holds = parse_frames("p1073r42p1090r43p1157r44", &kilter_state_map());
        assert_eq!(holds.len(), 3);
        assert_eq!(holds[0].hold_id, 1073);
        assert_eq!(holds[0].color.r, 0);
        assert_eq!(holds[0].color.g, 255);
        assert_eq!(holds[0].color.b, 0);
        assert_eq!(holds[1].hold_id, 1090);
        assert_eq!(holds[2].hold_id, 1157);
    }

    #[test]
    fn test_parse_multi_frame_uses_first() {
        let holds = parse_frames("p1r42p2r43,p3r44p4r45", &kilter_state_map());
        assert_eq!(holds.len(), 2);
        assert_eq!(holds[0].hold_id, 1);
        assert_eq!(holds[1].hold_id, 2);
    }

    #[test]
    fn test_parse_empty_frames() {
        let holds = parse_frames("", &kilter_state_map());
        assert_eq!(holds.len(), 0);
    }

    #[test]
    fn test_parse_unknown_state_code_skipped() {
        let holds = parse_frames("p1r99p2r42", &kilter_state_map());
        assert_eq!(holds.len(), 1);
        assert_eq!(holds[0].hold_id, 2);
    }

    #[test]
    fn test_parse_render_style() {
        let mut state_map = kilter_state_map();
        state_map.insert(
            46,
            HoldStateInfo {
                color: "#FFE066".into(),
                render_style: crate::types::HoldRenderStyle::AboveMarker,
                shape: Default::default(),
            },
        );

        let holds = parse_frames("p1r46", &state_map);
        assert_eq!(holds.len(), 1);
        assert_eq!(
            holds[0].render_style,
            crate::types::HoldRenderStyle::AboveMarker
        );
    }
}
