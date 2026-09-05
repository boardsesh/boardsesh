// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

use board_renderer_core::renderer::render_overlay as render_overlay_impl;
use board_renderer_core::types::RenderConfig;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn render_overlay(config_json: &str) -> Result<Vec<u8>, JsValue> {
    let config: RenderConfig = serde_json::from_str(config_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse config: {e}")))?;

    let (rgba_data, width, height) = render_overlay_impl(&config)
        .map_err(|e| JsValue::from_str(&format!("Render failed: {e}")))?;

    let mut result = Vec::with_capacity(8 + rgba_data.len());
    result.extend_from_slice(&width.to_le_bytes());
    result.extend_from_slice(&height.to_le_bytes());
    result.extend_from_slice(&rgba_data);

    Ok(result)
}
