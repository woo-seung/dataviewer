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

/// If a WebView2 process dies (out of memory, GPU/driver trouble) the window
/// would stay blank. Log why and bring the UI back: reload the page for a dead
/// or hung renderer, restart the app if the whole browser process is gone.
/// The workspace reopens by itself (last file / Untitled autosave).
#[cfg(windows)]
fn watch_webview(win: &tauri::WebviewWindow, app: tauri::AppHandle, eng: Arc<Engine>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, ProcessFailedEventHandler};
    use windows::core::{Interface, PWSTR};
    let _ = win.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        // runtime version and where WebView2 writes its crash dumps
        if let Ok(env) = core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()) {
            let mut ver = PWSTR::null();
            let _ = env.BrowserVersionString(&mut ver);
            let mut dir = PWSTR::null();
            let dumps = env.cast::<ICoreWebView2Environment11>().and_then(|e| e.FailureReportFolderPath(&mut dir)).ok().map(|_| take_pwstr(dir));
            eng.log(&format!("WebView2 {} · crash dumps: {}", take_pwstr(ver), dumps.as_deref().unwrap_or("?")));
            if let Some(d) = dumps {
                for line in recent_dumps(std::path::Path::new(&d)) {
                    eng.log(&line);
                }
            }
        }
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            let mut code = 0i32;
            let mut module = String::new();
            let mut desc = String::new();
            if let Some(a) = &args {
                let _ = a.ProcessFailedKind(&mut kind);
                if let Ok(a2) = a.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let _ = a2.Reason(&mut reason);
                    let _ = a2.ExitCode(&mut code);
                    let mut p = PWSTR::null();
                    if a2.ProcessDescription(&mut p).is_ok() {
                        desc = take_pwstr(p);
                    }
                }
                if let Ok(a3) = a.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
                    let mut p = PWSTR::null();
                    if a3.FailureSourceModulePath(&mut p).is_ok() {
                        module = take_pwstr(p);
                    }
                }
            }
            eng.log(&format!("WebView2 process failed: kind={} reason={} exitCode={:#x} module={:?} process={:?}", kind.0, reason.0, code as u32, module, desc));
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                eng.log("restarting app");
                app.restart();
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED
            {
                if let Some(s) = sender {
                    eng.log("reloading UI");
                    let _ = s.Reload();
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

/// The newest crash dumps WebView2 left behind, for the log.
#[cfg(windows)]
fn recent_dumps(dir: &std::path::Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("dmp")) {
                if let Ok(m) = e.metadata() {
                    files.push((m.modified().ok(), m.len(), p));
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .take(3)
        .map(|(t, len, p)| {
            let age = t.and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() / 60).unwrap_or(0);
            format!("crash dump {} ({} KB, {} min ago)", p.display(), len / 1024, age)
        })
        .collect()
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
            let eng = Arc::new(Engine::with_data_dir(dir, env!("CARGO_PKG_VERSION")));
            *eng.launch_files.lock().unwrap() = launch.clone();
            eng.log(&format!("start v{} args={:?}", env!("CARGO_PKG_VERSION"), launch));
            let panic_eng = eng.clone();
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                panic_eng.log(&format!("PANIC: {info}"));
                default_hook(info);
            }));
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("main") {
                watch_webview(&win, app.handle().clone(), eng.clone());
            }
            app.manage(eng);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine])
        .run(tauri::generate_context!())
        .expect("error while running Chronos Vault");
}
