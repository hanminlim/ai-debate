// claude·codex CLI 실행. 각자 로그인한 구독으로만 부르고, 파일 접근은 고른 프로젝트 폴더 안 읽기 전용으로 둔다
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::OnceCell;

static SHELL_PATH: OnceCell<String> = OnceCell::const_new();

// Finder 로 연 앱은 터미널의 PATH 를 물려받지 못해 ~/.local/bin 의 claude 를 못 찾는다.
// 로그인 셸에서 한 번 받아 오고, 흔한 설치 위치를 덧붙인다
pub async fn shell_path() -> &'static str {
    SHELL_PATH
        .get_or_init(|| async {
            let home = std::env::var("HOME").unwrap_or_default();
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let probe = Command::new(&shell)
                .args(["-ilc", "printf '__PATH__%s__PATH__' \"$PATH\""])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output();
            let from_shell = match tokio::time::timeout(Duration::from_secs(5), probe).await {
                Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout)
                    .split("__PATH__")
                    .nth(1)
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            };
            let mut parts: Vec<String> = from_shell.split(':').filter(|s| !s.is_empty()).map(String::from).collect();
            for extra in [
                format!("{home}/.local/bin"),
                format!("{home}/.npm-global/bin"),
                "/opt/homebrew/bin".into(),
                "/usr/local/bin".into(),
                "/usr/bin".into(),
                "/bin".into(),
            ] {
                if !parts.contains(&extra) {
                    parts.push(extra);
                }
            }
            parts.join(":")
        })
        .await
}

// API 키·다른 제공자 설정이 환경에 있으면 CLI 가 그쪽(과금)으로 호출한다.
// 지울 목록을 쫓아가는 대신 꼭 필요한 변수만 넘겨 구독 로그인으로만 부르게 한다
const PASS_ENV: &[&str] = &["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

pub fn pass_env() -> Vec<(String, String)> {
    PASS_ENV.iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
}

pub async fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear().envs(pass_env()).env("PATH", shell_path().await).kill_on_drop(true);
    cmd
}

// 앱을 끌 때 아직 도는 호출을 모두 끊는다(종료 시에는 kill_on_drop 이 동작하지 않는다)
pub fn cancel_all(running: &Running) {
    let pids: Vec<u32> = running.lock().unwrap().drain().map(|(_, pid)| pid).collect();
    for pid in pids {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
    }
}

pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub type Running = Mutex<HashMap<String, u32>>;

// id 를 주면 실행 중 pid 를 기록해 cancel 로 끊을 수 있게 한다
pub async fn run(program: &str, args: &[String], input: &str, cwd: &Path, id: Option<&str>, running: Option<&Running>) -> Result<Output, String> {
    let mut child = command(program)
        .await
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("NOT_INSTALLED:{program} 를 찾을 수 없습니다"),
            _ => e.to_string(),
        })?;
    if let (Some(id), Some(running), Some(pid)) = (id, running, child.id()) {
        running.lock().unwrap().insert(id.to_string(), pid);
    }
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string());
    if let (Some(id), Some(running)) = (id, running) {
        running.lock().unwrap().remove(id);
    }
    let out = out?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

// 사용량 한도에 걸렸는지: 화면에서 "기절" 이벤트로 보여 준다
pub fn is_limit_error(status: Option<i64>, text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)usage limit|rate limit|hit your( usage)? limit|limit reached|out of (extra )?usage|quota exceeded|insufficient_quota").unwrap()
    });
    status == Some(429) || re.is_match(text)
}

// 토론 대상 코드 폴더: 절대 경로의 실제 디렉터리만 받는다
pub fn codebase_dir(path: &str) -> Result<Option<PathBuf>, String> {
    if path.is_empty() {
        return Ok(None);
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("코드 폴더는 절대 경로여야 합니다".into());
    }
    if !p.is_dir() {
        return Err(format!("폴더를 찾을 수 없습니다: {path}"));
    }
    Ok(Some(p))
}

pub fn claude_args(model: &str, system: &str, schema: Option<&Value>, codebase: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--safe-mode", // 각자의 CLAUDE.md·훅·플러그인이 토론자에게 섞이지 않게 한다
        "--restricted", // 파일 도구를 작업 폴더 안으로 가두고 사용자 설정의 허용 범위를 무시한다
        "--permission-prompts",
        "none",
        "--tools",
        if codebase { "Read,Grep,Glob" } else { "" }, // 코드를 볼 때도 읽기 전용
        "--no-session-persistence",
        "--model",
        model,
        "--system-prompt",
        system,
        "--output-format",
        "json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(schema) = schema {
        args.push("--json-schema".into());
        args.push(schema.to_string());
    }
    args
}

// codex 의 read-only 샌드박스는 쓰기만 막고 읽기는 디스크 전체가 열려 있다. 폴더 밖은 지시로만 막는다
pub fn codex_args(model: &str, schema_file: &Path, out_file: &Path, cwd: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--model",
        model,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config", // 각자의 MCP·설정이 토론자에게 섞이지 않게 한다
        "--ignore-rules",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(["--output-schema".into(), schema_file.display().to_string()]);
    args.extend(["-o".into(), out_file.display().to_string()]);
    args.extend(["-C".into(), cwd.display().to_string(), "-".into()]);
    args
}

#[derive(Deserialize)]
pub struct AskReq {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub system: String,
    pub prompt: String,
    pub schema: Option<Value>,
    #[serde(default)]
    pub codebase: String,
}

#[derive(Serialize)]
pub struct AskRes {
    pub text: String,
    pub data: Value,
}

// 로그인이 끊겼는지: 토론을 멈추고 다시 로그인하면 이어서 진행한다
pub fn is_auth_error(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)refresh token|sign in again|log in again|please (run )?/?login|not logged in|unauthorized \(401\)|status 401|authentication_error|invalid api key|oauth token (has )?expired|token (has )?expired|invalid_grant").unwrap()
    });
    re.is_match(text)
}

// 화면이 오류 종류를 가릴 수 있게 앞에 표시를 붙인다(AUTH: 로그인 끊김, LIMIT: 사용량 한도)
fn classify(status: Option<i64>, msg: String) -> String {
    if is_auth_error(&msg) || status == Some(401) {
        format!("AUTH:{msg}")
    } else if is_limit_error(status, &msg) {
        format!("LIMIT:{msg}")
    } else {
        msg
    }
}

fn limit_or(msg: String) -> String {
    classify(None, msg)
}

pub async fn ask(req: AskReq, running: &Running) -> Result<AskRes, String> {
    let codebase = codebase_dir(&req.codebase)?;
    let cwd = codebase.clone().unwrap_or_else(std::env::temp_dir);
    match req.provider.as_str() {
        "claude" => {
            let args = claude_args(&req.model, &req.system, req.schema.as_ref(), codebase.is_some());
            let out = run("claude", &args, &req.prompt, &cwd, Some(&req.id), Some(running)).await?;
            let parsed: Value = serde_json::from_str(&out.stdout)
                .map_err(|_| limit_or(if out.stderr.is_empty() { out.stdout.clone() } else { out.stderr.clone() }))?;
            let text = parsed["result"].as_str().unwrap_or("").to_string();
            if parsed["is_error"].as_bool().unwrap_or(false) {
                return Err(classify(parsed["api_error_status"].as_i64(), text));
            }
            Ok(AskRes { data: parsed["structured_output"].clone(), text })
        }
        "codex" => {
            let tmp = std::env::temp_dir();
            let schema_file = tmp.join(format!("ai-debate-{}-schema.json", req.id));
            let out_file = tmp.join(format!("ai-debate-{}-out.json", req.id));
            let schema = req.schema.clone().unwrap_or(Value::Null);
            tokio::fs::write(&schema_file, schema.to_string()).await.map_err(|e| e.to_string())?;
            let guard = if codebase.is_some() {
                "\n작업 폴더 밖의 파일은 절대 읽지 않는다. 명령은 읽기용(ls, cat, rg 등)만 쓴다."
            } else {
                "\n파일이나 명령을 쓰지 말고 바로 답한다."
            };
            let input = format!("{}{}\n\n{}", req.system, guard, req.prompt);
            let args = codex_args(&req.model, &schema_file, &out_file, &cwd);
            let result = run("codex", &args, &input, &cwd, Some(&req.id), Some(running)).await;
            let last = tokio::fs::read_to_string(&out_file).await.unwrap_or_default();
            let _ = tokio::fs::remove_file(&schema_file).await;
            let _ = tokio::fs::remove_file(&out_file).await;
            let out = result?;
            if !out.ok || last.trim().is_empty() {
                let msg = format!("{}\n{}", out.stderr.trim(), out.stdout.trim());
                let tail: String = msg.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
                return Err(limit_or(tail));
            }
            let data = serde_json::from_str(&last).unwrap_or(Value::Null);
            Ok(AskRes { text: last, data })
        }
        other => Err(format!("알 수 없는 제공자: {other}")),
    }
}

// 로그인이 실제로 살아 있는지 아주 짧은 호출로 확인한다(login status 는 저장된 정보만 보고 만료를 못 잡는다)
pub async fn verify(provider: &str) -> Result<(), String> {
    let tmp = std::env::temp_dir();
    let out = match provider {
        "claude" => {
            let args = claude_args("haiku", "한 단어로만 답한다.", None, false);
            let out = run("claude", &args, "ok", &tmp, None, None).await?;
            let v: Value = serde_json::from_str(&out.stdout).unwrap_or(Value::Null);
            if v["is_error"] == Value::Bool(false) {
                return Ok(());
            }
            format!("{} {}", v["result"].as_str().unwrap_or(""), out.stderr)
        }
        "codex" => {
            let args: Vec<String> = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            let out = run("codex", &args, "Reply with the single word OK. Do not run any commands.", &tmp, None, None).await?;
            if out.ok {
                return Ok(());
            }
            format!("{}\n{}", out.stderr, out.stdout)
        }
        other => return Err(format!("알 수 없는 제공자: {other}")),
    };
    Err(classify(None, out.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect()))
}

pub fn cancel(id: &str, running: &Running) {
    if let Some(pid) = running.lock().unwrap().remove(id) {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_is_always_restricted_and_read_only() {
        let with_code = claude_args("claude-haiku-5-5", "s", None, true);
        let without = claude_args("claude-haiku-5-5", "s", None, false);
        let tools = |a: &Vec<String>| a[a.iter().position(|x| x == "--tools").unwrap() + 1].clone();
        assert_eq!(tools(&with_code), "Read,Grep,Glob");
        assert_eq!(tools(&without), "");
        for a in [&with_code, &without] {
            assert!(a.contains(&"--restricted".to_string()) && a.contains(&"--safe-mode".to_string()));
        }
    }

    #[test]
    fn codex_is_read_only_and_ignores_user_config() {
        let a = codex_args("gpt-5.6-luna", Path::new("/t/s.json"), Path::new("/t/o.json"), Path::new("/repo"));
        let sandbox = &a[a.iter().position(|x| x == "--sandbox").unwrap() + 1];
        assert_eq!(sandbox, "read-only");
        assert!(a.contains(&"--ignore-user-config".to_string()));
        assert_eq!(a.last().unwrap(), "-"); // 프롬프트는 stdin 으로
    }

    #[test]
    fn billing_env_vars_are_never_passed() {
        std::env::set_var("ANTHROPIC_API_KEY", "x");
        std::env::set_var("CODEX_API_KEY", "x");
        std::env::set_var("ANTHROPIC_BASE_URL", "x");
        let keys: Vec<String> = pass_env().into_iter().map(|(k, _)| k).collect();
        assert!(keys.contains(&"HOME".to_string()));
        for k in ["ANTHROPIC_API_KEY", "CODEX_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"] {
            assert!(!keys.contains(&k.to_string()), "{k}");
        }
    }

    #[test]
    fn detects_expired_logins() {
        let codex = "ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";
        assert!(classify(None, codex.into()).starts_with("AUTH:"));
        assert!(classify(None, "ERROR: workspace routing discovery unauthorized (401)".into()).starts_with("AUTH:"));
        assert!(classify(None, "OAuth token has expired. Please run /login".into()).starts_with("AUTH:"));
        assert!(classify(Some(429), "rate limited".into()).starts_with("LIMIT:"));
        assert_eq!(classify(Some(500), "Internal server error".into()), "Internal server error");
    }

    #[test]
    fn detects_usage_limits() {
        assert!(is_limit_error(Some(429), ""));
        assert!(is_limit_error(None, "Claude AI usage limit reached|1792660800"));
        assert!(is_limit_error(None, "You've hit your usage limit. Upgrade to Pro"));
        assert!(!is_limit_error(Some(500), "Internal server error"));
    }

    // 실제 CLI 를 부른다(구독 사용량을 조금 쓴다). cargo test -- --ignored 로만 돈다
    #[tokio::test]
    #[ignore]
    async fn live_ask_claude_and_codex() {
        let running = Running::default();
        let schema = serde_json::json!({
            "type": "object", "properties": { "answer": { "type": "string" } },
            "required": ["answer"], "additionalProperties": false
        });
        let repo = env!("CARGO_MANIFEST_DIR").to_string();
        for (provider, model) in [("claude", "claude-haiku-5-5"), ("codex", "gpt-5.6-luna")] {
            let req = AskReq {
                id: format!("live-{provider}"),
                provider: provider.into(),
                model: model.into(),
                system: "한 문장으로 답한다.".into(),
                prompt: "Cargo.toml 의 패키지 이름이 뭔가?".into(),
                schema: Some(schema.clone()),
                codebase: repo.clone(),
            };
            let res = ask(req, &running).await.unwrap_or_else(|e| panic!("{provider}: {e}"));
            let answer = res.data["answer"].as_str().unwrap_or("");
            println!("{provider}: {answer}");
            assert!(answer.contains("ai-debate"), "{provider} 답: {answer}");
        }
    }

    // 실제 로그인 상태를 짧게 확인한다. cargo test -- --ignored 로만 돈다
    #[tokio::test]
    #[ignore]
    async fn live_verify_logins() {
        for provider in ["claude", "codex"] {
            println!("{provider}: {:?}", verify(provider).await);
        }
    }

    #[test]
    fn codebase_must_be_existing_absolute_dir() {
        assert_eq!(codebase_dir("").unwrap(), None);
        assert!(codebase_dir("relative/x").is_err());
        assert!(codebase_dir("/no/such/dir/xyz").is_err());
        let tmp = std::env::temp_dir();
        assert_eq!(codebase_dir(tmp.to_str().unwrap()).unwrap(), Some(tmp));
    }
}
