// 시작 전 연결 확인: CLI 설치·로그인, 폴더 접근 권한, 쓸 수 있는 모델
use crate::cli::{command, run};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default)]
pub struct Provider {
    pub installed: bool,
    pub logged_in: bool,
    pub detail: String,
}

#[derive(Serialize)]
pub struct Folder {
    pub name: String,
    pub path: String,
    pub ok: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Model {
    pub id: String,
    pub label: String,
}

fn installed(err: &str) -> bool {
    !err.starts_with("NOT_INSTALLED:")
}

pub async fn claude() -> Provider {
    match run("claude", &["auth".into(), "status".into()], "", &std::env::temp_dir(), None, None).await {
        Ok(out) => {
            let status: Value = serde_json::from_str(&out.stdout).unwrap_or(Value::Null);
            let method = status["authMethod"].as_str().unwrap_or("");
            let plan = status["subscriptionType"].as_str().unwrap_or("");
            Provider {
                installed: true,
                logged_in: status["loggedIn"].as_bool().unwrap_or(false),
                detail: if plan.is_empty() { method.to_string() } else { format!("{method} · {plan}") },
            }
        }
        Err(e) => Provider { installed: installed(&e), detail: e, ..Default::default() },
    }
}

pub async fn codex() -> Provider {
    match run("codex", &["login".into(), "status".into()], "", &std::env::temp_dir(), None, None).await {
        Ok(out) => {
            let text = format!("{}{}", out.stdout, out.stderr);
            Provider { installed: true, logged_in: out.ok && text.contains("Logged in"), detail: text.trim().to_string() }
        }
        Err(e) => Provider { installed: installed(&e), detail: e, ..Default::default() },
    }
}

// 문서·데스크탑을 한 번 읽어 본다. 처음이면 macOS 가 이 앱에 접근 허용을 묻는다
pub fn folders(home: &Path) -> Vec<Folder> {
    [("문서", "Documents"), ("데스크탑", "Desktop")]
        .iter()
        .map(|(name, dir)| {
            let path = home.join(dir);
            Folder { name: name.to_string(), ok: std::fs::read_dir(&path).is_ok(), path: path.display().to_string() }
        })
        .collect()
}

// Claude CLI 는 모델 목록을 알려 주지 않아 후보를 짧게 불러 보고 되는 것만 남긴다
const CLAUDE_CANDIDATES: &[&str] = &[
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-opus-5-4",
    "claude-sonnet-5-4",
    "claude-opus-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-5",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
];

// claude-opus-5-5 → Claude Opus 5.5
pub fn claude_label(id: &str) -> String {
    let mut parts = id.split('-').skip(1);
    let family = parts.next().unwrap_or("");
    let version: Vec<&str> = parts.collect();
    let mut family_cap = family.to_string();
    if let Some(f) = family_cap.get_mut(0..1) {
        f.make_ascii_uppercase();
    }
    format!("Claude {family_cap} {}", version.join("."))
}

// Some(true/false): 되는지 안 되는지 / None: 한도에 걸려 판단할 수 없음
async fn claude_works(id: &str) -> Option<bool> {
    let args: Vec<String> = [
        "-p", "--safe-mode", "--restricted", "--tools", "", "--no-session-persistence", "--model", id,
        "--system-prompt", "한 단어로만 답한다.", "--output-format", "json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let Ok(out) = run("claude", &args, "ok", &std::env::temp_dir(), None, None).await else { return Some(false) };
    let v: Value = serde_json::from_str(&out.stdout).unwrap_or(Value::Null);
    if v["is_error"] == Value::Bool(false) {
        return Some(true);
    }
    let text = format!("{} {}", v["result"].as_str().unwrap_or(""), out.stderr);
    if crate::cli::is_limit_error(v["api_error_status"].as_i64(), &text) {
        None
    } else {
        Some(false)
    }
}

pub async fn claude_models(cache: PathBuf, force: bool) -> Vec<Model> {
    if !force {
        if let Ok(raw) = tokio::fs::read_to_string(&cache).await {
            if let Ok(models) = serde_json::from_str::<Vec<Model>>(&raw) {
                if !models.is_empty() {
                    return models;
                }
            }
        }
    }
    let probes: Vec<_> = CLAUDE_CANDIDATES
        .iter()
        .map(|id| tokio::spawn(async move { (id, claude_works(id).await) }))
        .collect();
    let mut models = vec![];
    let mut unsure = false;
    for p in probes {
        match p.await {
            Ok((id, Some(true))) => models.push(Model { id: id.to_string(), label: claude_label(id) }),
            Ok((_, None)) => unsure = true,
            _ => {}
        }
    }
    // 한도 때문에 판단 못 한 모델이 있으면 저장하지 않는다. 저장하면 그 모델이 계속 빠진 채로 남는다
    if !unsure {
        if let Some(dir) = cache.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let _ = tokio::fs::write(&cache, serde_json::to_string(&models).unwrap_or_default()).await;
    }
    models
}

// codex 는 모델 카탈로그를 직접 알려 준다. 목록에 보이는 것(visibility=list)만 쓴다
pub async fn codex_models() -> Vec<Model> {
    let Ok(out) = command("codex").await.args(["debug", "models"]).output().await else { return vec![] };
    let catalog: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    parse_codex_models(&catalog)
}

pub fn parse_codex_models(catalog: &Value) -> Vec<Model> {
    catalog["models"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|m| m["visibility"] == "list")
                .map(|m| Model {
                    id: m["slug"].as_str().unwrap_or("").to_string(),
                    label: format!("Codex {}", m["display_name"].as_str().unwrap_or("")),
                })
                .filter(|m| !m.id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_claude_ids() {
        assert_eq!(claude_label("claude-opus-5-5"), "Claude Opus 5.5");
        assert_eq!(claude_label("claude-sonnet-5"), "Claude Sonnet 5");
        assert_eq!(claude_label("claude-fable-5-1"), "Claude Fable 5.1");
    }

    #[test]
    fn keeps_only_listed_codex_models() {
        let catalog = serde_json::json!({ "models": [
            { "slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide" },
            { "slug": "gpt-5.6-terra", "display_name": "GPT-5.6-Terra", "visibility": "list" },
        ]});
        let models = parse_codex_models(&catalog);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.6-terra");
        assert_eq!(models[0].label, "Codex GPT-5.6-Terra");
    }
}
