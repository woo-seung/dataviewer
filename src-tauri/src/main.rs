// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use chronos_engine::Engine;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// Every data operation goes through this one command (see engine::Engine::call).
/// Work runs on a blocking thread so the UI never stalls, and replies are raw
/// bytes so chart windows reach the webview without JSON encoding.
#[tauri::command]
async fn engine(cmd: String, args: Value, app: tauri::AppHandle, state: tauri::State<'_, Arc<Engine>>) -> Result<tauri::ipc::Response, String> {
    let eng = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |ev: &str, payload: Value| {
            let _ = app.emit("engine-event", json!({ "event": ev, "payload": payload }));
        };
        eng.call(&cmd, args, &emit).map(|r| tauri::ipc::Response::new(r.encode())).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// File arguments (double-clicked .chronos / CSV, "Open with").
fn file_args(argv: impl IntoIterator<Item = String>) -> Vec<String> {
    argv.into_iter().skip(1).filter(|a| !a.starts_with('-')).collect()
}

fn main() {
    let launch = file_args(std::env::args());
    tauri::Builder::default()
        // must be first: a second launch hands its files to the running window
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let files = file_args(argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let eng = Engine::with_data_dir(dir, env!("CARGO_PKG_VERSION"));
            *eng.launch_files.lock().unwrap() = launch.clone();
            app.manage(Arc::new(eng));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine])
        .run(tauri::generate_context!())
        .expect("error while running Chronos Vault");
}
