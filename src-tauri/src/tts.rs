// 음성 엔진 Supertonic. 앱 데이터 폴더의 venv 에 설치하고, 앱이 떠 있는 동안 로컬 서버(127.0.0.1:7788)로 띄운다
use crate::cli::command;
use serde::Serialize;
use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

const ADDR: &str = "127.0.0.1:7788";
const PACKAGE: &str = "supertonic[serve]==1.3.1";

pub fn bin(dir: &Path) -> PathBuf {
    dir.join("venv/bin/supertonic")
}

#[derive(Serialize)]
pub struct Status {
    pub installed: bool,
    pub running: bool,
}

pub fn running() -> bool {
    TcpStream::connect_timeout(&ADDR.parse().unwrap(), Duration::from_millis(300)).is_ok()
}

pub fn status(dir: &Path) -> Status {
    Status { installed: bin(dir).exists(), running: running() }
}

// 이미 떠 있으면(다른 앱이 띄운 것 포함) 그대로 쓴다
pub fn start(dir: &Path) -> Option<std::process::Child> {
    if running() || !bin(dir).exists() {
        return None;
    }
    std::process::Command::new(bin(dir))
        .args(["serve", "--host", "127.0.0.1", "--port", "7788", "--log-level", "warning"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

async fn step(app: &AppHandle, program: &str, args: &[&str]) -> Result<(), String> {
    let _ = app.emit("tts-progress", format!("$ {} {}", program.rsplit('/').next().unwrap_or(program), args.join(" ")));
    let mut child = command(program)
        .await
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program} 실행 실패: {e}"))?;
    // pip·다운로드 진행 상황을 화면에 흘려 보낸다
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut errs = BufReader::new(child.stderr.take().unwrap()).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => { let _ = app.emit("tts-progress", l); }
                _ => break,
            },
            line = errs.next_line() => if let Ok(Some(l)) = line { let _ = app.emit("tts-progress", l); },
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} {} 실패", args.join(" ")))
    }
}

pub async fn install(app: &AppHandle, dir: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let venv = dir.join("venv");
    let venv_s = venv.display().to_string();
    step(app, "python3", &["-m", "venv", &venv_s]).await?;
    let pip = venv.join("bin/pip").display().to_string();
    step(app, &pip, &["install", PACKAGE]).await?;
    step(app, &bin(dir).display().to_string(), &["download"]).await
}

// 브라우저가 로컬 서버를 직접 부르면 CORS·CSP 를 따로 열어야 해서 앱이 대신 받아 넘긴다
pub fn synthesize(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let res = ureq::post(&format!("http://{ADDR}/v1/tts"))
        .timeout(Duration::from_secs(60))
        .send_json(serde_json::json!({ "text": text, "voice": voice, "lang": "ko", "response_format": "wav" }))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    res.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
