//! 应用设置（PRD §3.9）。持久化到 app data 目录的 `settings.json`。

use crate::models::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    pub provider: String, // "anthropic" | "openai" | "custom"
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// API Key 存钥匙串，这里只标记是否已配置。
    #[serde(default)]
    pub key_configured: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            base_url: None,
            key_configured: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: Theme,
    pub language: String,
    pub default_page_size: u64,
    pub editor_font_size: u32,
    pub auto_uppercase_keywords: bool,
    pub ai: AiSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            language: "zh-CN".into(),
            default_page_size: 1000,
            editor_font_size: 13,
            auto_uppercase_keywords: false,
            ai: AiSettings::default(),
        }
    }
}

/// 应用数据根目录：`~/.sidb/`（TDD §6.1）。
pub fn data_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".sidb")
}

fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read_to_string(settings_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(s: &Settings) -> Result<(), AppError> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Internal(e.to_string()))?;
    // 原子写：临时文件 + rename。
    let tmp = dir.join("settings.json.tmp");
    let body = serde_json::to_string_pretty(s).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::write(&tmp, body).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, settings_path()).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.default_page_size, 1000);
        assert_eq!(s.language, "zh-CN");
        assert!(!s.ai.key_configured);
    }

    #[test]
    fn settings_roundtrip_json() {
        let s = Settings::default();
        let j = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&j).unwrap();
        assert_eq!(back.default_page_size, s.default_page_size);
    }
}
