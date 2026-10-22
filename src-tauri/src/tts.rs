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
// 동작을 확인한 하위 의존성 버전. 설치 시점의 최신판이 들어오지 않게 고정한다
const CONSTRAINTS: &str = "annotated-doc==0.0.5\nannotated-types==0.8.0\nanyio==4.15.1\ncffi==2.1.1\nclick==8.5.0\nfastapi==0.159.1\nfilelock==4.2.4\nflatbuffers==25.12.19\nfsspec==2026.9.0\nh11==0.16.0\nhf-xet==1.7.0\nhttpcore2==2.16.0\nhttptools==0.9.0\nhttpx2==2.16.0\nhuggingface_hub==2.2.0\nidna==3.20\nnumpy==2.4.6\nonnxruntime==1.31.0\nopentelemetry-api==1.45.1\npackaging==26.3\nprotobuf==7.36.2\npycparser==3.11\npydantic==2.14.1\npydantic_core==2.50.1\npython-dotenv==1.2.4\npython-multipart==0.0.32\nPyYAML==6.0.3\nsoundfile==0.14.0\nstarlette==1.9.0\ntqdm==4.70.1\ntruststore==0.10.5\ntyping-inspection==0.4.4\ntyping_extensions==4.16.0\nuvicorn==0.54.0\nuvloop==0.23.0\nwatchfiles==1.3.0\nwebsockets==17.3\n";

pub fn bin(dir: &Path) -> PathBuf {
    dir.join("venv/bin/supertonic")
}

#[derive(Serialize)]
pub struct Status {
    pub installed: bool,
    pub running: bool,
}

fn port_open() -> bool {
    TcpStream::connect_timeout(&ADDR.parse().unwrap(), Duration::from_millis(300)).is_ok()
}

// 포트만 열려 있다고 믿지 않는다. 다른 프로그램이 먼저 잡고 있으면 대본이 그쪽으로 새므로
// 상태 응답이 Supertonic 인지 확인한다
pub fn running() -> bool {
    if !port_open() {
        return false;
    }
    ureq::get(&format!("http://{ADDR}/v1/health"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()
        .and_then(|r| r.into_json::<serde_json::Value>().ok())
        .is_some_and(|v| v["model"].as_str().is_some_and(|m| m.starts_with("supertonic")))
}

pub fn status(dir: &Path) -> Status {
    Status { installed: bin(dir).exists(), running: running() }
}

// 이미 떠 있으면(다른 앱이 띄운 것 포함) 그대로 쓴다
pub fn start(dir: &Path) -> Option<std::process::Child> {
    if port_open() || !bin(dir).exists() {
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
    let constraints = dir.join("constraints.txt");
    tokio::fs::write(&constraints, CONSTRAINTS).await.map_err(|e| e.to_string())?;
    step(app, &pip, &["install", "-c", &constraints.display().to_string(), PACKAGE]).await?;
    step(app, &bin(dir).display().to_string(), &["download"]).await
}

// 브라우저가 로컬 서버를 직접 부르면 CORS·CSP 를 따로 열어야 해서 앱이 대신 받아 넘긴다
pub fn synthesize(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    if !running() {
        return Err("음성 엔진이 꺼져 있습니다".into());
    }
    let res = ureq::post(&format!("http://{ADDR}/v1/tts"))
        .timeout(Duration::from_secs(60))
        .send_json(serde_json::json!({ "text": text, "voice": voice, "lang": "ko", "response_format": "wav" }))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    res.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
