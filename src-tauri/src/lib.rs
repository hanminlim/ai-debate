mod cli;
mod env;
mod projects;
mod tts;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{ipc::Response, AppHandle, Manager, RunEvent, State};

struct AppState {
    running: cli::Running,
    tts: Mutex<Option<std::process::Child>>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("ai-debate"))
}

#[derive(Serialize)]
struct EnvReport {
    claude: env::Provider,
    codex: env::Provider,
    folders: Vec<env::Folder>,
    tts: tts::Status,
}

#[tauri::command]
async fn env_check(app: AppHandle) -> EnvReport {
    let (claude, codex) = tokio::join!(env::claude(), env::codex());
    let folders = tauri::async_runtime::spawn_blocking(|| env::folders(&home())).await.unwrap_or_default();
    EnvReport { claude, codex, folders, tts: tts::status(&data_dir(&app).join("tts")) }
}

#[tauri::command]
async fn claude_models(app: AppHandle, force: bool) -> Vec<env::Model> {
    env::claude_models(data_dir(&app).join("claude-models.json"), force).await
}

#[tauri::command]
async fn codex_models() -> Vec<env::Model> {
    env::codex_models().await
}

#[tauri::command]
async fn ask(req: cli::AskReq, state: State<'_, AppState>) -> Result<cli::AskRes, String> {
    cli::ask(req, &state.running).await
}

#[tauri::command]
fn cancel(id: String, state: State<'_, AppState>) {
    cli::cancel(&id, &state.running);
}

#[tauri::command]
async fn list_projects(problem: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || projects::list_projects(&problem, &home())).await.unwrap_or_default()
}

#[tauri::command]
fn tts_status(app: AppHandle) -> tts::Status {
    tts::status(&data_dir(&app).join("tts"))
}

#[tauri::command]
async fn tts_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let dir = data_dir(&app).join("tts");
    tts::install(&app, &dir).await?;
    *state.tts.lock().unwrap() = tts::start(&dir);
    Ok(())
}

#[tauri::command]
async fn tts(text: String, voice: String) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || tts::synthesize(&text, &voice))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn verify_login(provider: String) -> Result<(), String> {
    cli::verify(&provider).await
}

// 다시 로그인: 터미널에서 로그인 명령을 실행하는 .command 파일을 만들어 연다(자동화 권한이 필요 없다)
#[tauri::command]
async fn open_login(app: AppHandle, provider: String) -> Result<(), String> {
    let cmd = match provider.as_str() {
        "claude" => "claude auth login",
        "codex" => "codex logout; codex login",
        _ => return Err("알 수 없는 제공자입니다".into()),
    };
    let dir = data_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("login-{provider}.command"));
    let script = format!(
        "#!/bin/zsh -l\necho 'AI Debate: {provider} 에 다시 로그인합니다.'\n{cmd}\necho\necho '끝났으면 이 창을 닫고 앱에서 \"로그인했어요\" 를 누르세요.'\n"
    );
    std::fs::write(&file, script).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    std::process::Command::new("open").arg(&file).status().map(|_| ()).map_err(|e| e.to_string())
}

const OPENABLE: &[&str] = &["x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"];

// 화면에서 실제로 여는 주소(파일·폴더 권한 설정)만 연다
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !OPENABLE.contains(&url.as_str()) {
        return Err("열 수 없는 주소입니다".into());
    }
    std::process::Command::new("open").arg(url).status().map(|_| ()).map_err(|e| e.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState { running: Default::default(), tts: Mutex::new(None) })
        .setup(|app| {
            let dir = data_dir(app.handle()).join("tts");
            *app.state::<AppState>().tts.lock().unwrap() = tts::start(&dir);
            // PATH 를 미리 받아 두어 첫 연결 확인이 느려지지 않게 한다
            tauri::async_runtime::spawn(async {
                cli::shell_path().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env_check,
            claude_models,
            codex_models,
            ask,
            cancel,
            list_projects,
            tts_status,
            tts_install,
            tts,
            open_url,
            verify_login,
            open_login
        ])
        .build(tauri::generate_context!())
        .expect("앱을 시작하지 못했습니다");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            cli::cancel_all(&state.running);
            let child = state.tts.lock().unwrap().take();
            if let Some(mut child) = child {
                let _ = child.kill();
            }
        }
    });
}
