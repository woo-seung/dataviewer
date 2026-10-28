//! The Chronos engine as a WebAssembly module for the browser.
//!
//! No bindgen: the JS worker (src/engine/worker.ts) copies arguments into
//! memory from `alloc`, calls `call(cmd, args JSON, binary input)` and reads
//! the reply (same tag-byte encoding as the desktop app) from `out_ptr` /
//! `out_len`. All file access stays in JS: imports are fed in chunks, cached
//! sources are loaded by JS filling arrays at the addresses we hand out, and
//! saves return the exact byte runs to write.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chronos_engine::chronos::{self, FileSource, Header, Piece};
use chronos_engine::csv::{self, ImportSettings, StreamImport};
use chronos_engine::{build_source, now_ms, Engine, Error, ExportItem, Reply, Source, SourceInfo};
use serde_json::{json, Value};

struct Pending {
    import: StreamImport,
    settings: ImportSettings,
}

struct Save {
    /// Keeps the borrowed arrays alive until JS has written them.
    _sources: Vec<Arc<Source>>,
    _owned: Vec<Vec<u8>>,
}

#[derive(Default)]
struct State {
    engine: Engine,
    imports: HashMap<String, Pending>,
    loads: HashMap<String, (Source, FileSource)>,
    saves: HashMap<String, Save>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static PANIC: RefCell<String> = const { RefCell::new(String::new()) };
}

#[no_mangle]
pub extern "C" fn init() {
    std::panic::set_hook(Box::new(|info| PANIC.with(|p| *p.borrow_mut() = info.to_string())));
}

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p`/`n` must come from `alloc(n)`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// Last panic message into the output buffer (after a trap).
#[no_mangle]
pub extern "C" fn panic_message() {
    let m = PANIC.with(|p| p.borrow().clone());
    OUT.with(|o| *o.borrow_mut() = m.into_bytes());
}

/// Wasm memory in use, in bytes.
#[no_mangle]
pub extern "C" fn memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    return (core::arch::wasm32::memory_size(0) as f64) * 65536.0;
    #[cfg(not(target_arch = "wasm32"))]
    0.0
}

/// Run one command; 0 = ok (reply in the output buffer), 1 = error message there.
///
/// # Safety
/// Pointers must reference `len` readable bytes in this module's memory.
#[no_mangle]
pub unsafe extern "C" fn call(cmd: *const u8, cmd_len: usize, args: *const u8, args_len: usize, bin: *const u8, bin_len: usize) -> u32 {
    let cmd = std::str::from_utf8(std::slice::from_raw_parts(cmd, cmd_len)).unwrap_or("");
    let args: Value = serde_json::from_slice(std::slice::from_raw_parts(args, args_len)).unwrap_or(Value::Null);
    let bin = if bin_len == 0 { &[][..] } else { std::slice::from_raw_parts(bin, bin_len) };
    let r = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.get_or_insert_with(State::default);
        dispatch(st, cmd, &args, bin)
    });
    let (code, bytes) = match r {
        Ok(reply) => (0, reply.encode()),
        Err(e) => (1, e.to_string().into_bytes()),
    };
    OUT.with(|o| *o.borrow_mut() = bytes);
    code
}

fn info(src: &Source) -> Result<Value, Error> {
    Ok(serde_json::to_value(SourceInfo::from(src))?)
}

fn dispatch(st: &mut State, cmd: &str, args: &Value, bin: &[u8]) -> Result<Reply, Error> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let need = |k: &str| s(k).ok_or_else(|| Error::msg(format!("'{k}' 인자가 필요합니다.")));
    let u = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(0.0) as u64;
    Ok(match cmd {
        "preview" => {
            let d = s("delimiter").filter(|d| !d.is_empty());
            Reply::Json(serde_json::to_value(csv::preview_bytes(bin, u("size"), d.as_deref())?)?)
        }
        "import_begin" => {
            let settings: ImportSettings = serde_json::from_value(args.get("settings").cloned().unwrap_or_default())?;
            st.imports.insert(need("job")?, Pending { import: StreamImport::new(settings.clone(), u("total")), settings });
            Reply::Json(json!(true))
        }
        "import_feed" => {
            let job = need("job")?;
            let p = st.imports.get_mut(&job).ok_or_else(|| Error::msg("가져오기 작업이 없습니다."))?;
            if let Err(e) = p.import.feed(bin) {
                st.imports.remove(&job);
                return Err(e);
            }
            Reply::Json(json!(true))
        }
        "import_end" => {
            let p = st.imports.remove(&need("job")?).ok_or_else(|| Error::msg("가져오기 작업이 없습니다."))?;
            let parsed = p.import.finish()?;
            let skipped = parsed.skipped;
            let name = need("name")?;
            let src = build_source(parsed, s("id"), name.clone(), PathBuf::from(&name), u("size"), u("lastModified") as i64, p.settings);
            let src = st.engine.insert(src);
            let mut v = info(&src)?;
            v["skipped"] = json!(skipped);
            Reply::Json(v)
        }
        "import_abort" => {
            st.imports.remove(&need("job")?);
            Reply::Json(json!(true))
        }
        "load_alloc" => {
            let key = need("key")?;
            let fs: FileSource = serde_json::from_value(args.get("source").cloned().unwrap_or_default())?;
            let mut src = chronos::blank_source(&fs, PathBuf::from(&fs.name));
            src.missing_original = args.get("missing").and_then(Value::as_bool).unwrap_or(false);
            let targets: Vec<Value> = chronos::section_targets(&mut src, &fs).into_iter().map(|(off, b)| json!([off, b.as_mut_ptr() as usize, b.len()])).collect();
            st.loads.insert(key, (src, fs));
            Reply::Json(json!({ "targets": targets }))
        }
        "load_commit" => {
            let (src, _) = st.loads.remove(&need("key")?).ok_or_else(|| Error::msg("불러오기 작업이 없습니다."))?;
            let src = st.engine.insert(src);
            Reply::Json(info(&src)?)
        }
        "load_abort" => {
            st.loads.remove(&need("key")?);
            Reply::Json(json!(true))
        }
        "save_plan" => {
            let key = need("key")?;
            let keep: Option<Vec<String>> = args.get("sources").and_then(|v| serde_json::from_value(v.clone()).ok());
            let sources = st.engine.snapshot(keep.as_deref());
            let existing: Option<Header> = args.get("existing").filter(|v| !v.is_null()).map(|v| serde_json::from_value(v.clone())).transpose()?;
            let plan = chronos::plan_save(existing.as_ref().map(|h| (h, u("existingLen"))), args.get("workspace").cloned().unwrap_or(Value::Null), &sources, now_ms(), None)?;
            let mut owned = Vec::new();
            let mut pieces = Vec::with_capacity(plan.pieces.len());
            for p in plan.pieces {
                match p {
                    Piece::Borrowed(b) => pieces.push(json!([b.as_ptr() as usize, b.len()])),
                    Piece::Owned(v) => {
                        pieces.push(json!([v.as_ptr() as usize, v.len()]));
                        owned.push(v);
                    }
                }
            }
            let out = json!({ "start": plan.start, "rewrite": plan.rewrite, "fileSize": plan.file_size, "pieces": pieces });
            st.saves.insert(key, Save { _sources: sources.clone(), _owned: owned });
            Reply::Json(out)
        }
        "save_done" => {
            st.saves.remove(&need("key")?);
            Reply::Json(json!(true))
        }
        "export_csv" => {
            let items: Vec<ExportItem> = serde_json::from_value(args.get("series").cloned().unwrap_or(json!([])))?;
            let f = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let mut out = Vec::new();
            st.engine.export_csv(&items, f("start"), f("end"), &mut out)?;
            Reply::Bytes(out)
        }
        "sample" => {
            let mut out = Vec::new();
            chronos_engine::sample_csv(&mut out)?;
            Reply::Bytes(out)
        }
        _ => st.engine.call(cmd, args.clone(), &|_, _| {})?,
    })
}
