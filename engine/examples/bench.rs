//! cargo run --release --example bench -- <dir> [rows]
use chronos_engine::{Engine, Reply};
use serde_json::{json, Value};
use std::io::{BufWriter, Write};
use std::time::Instant;

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("dir"));
    let rows: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(16_000_000);
    std::fs::create_dir_all(&dir).unwrap();
    let csv = dir.join("big.csv");
    if !csv.exists() {
        let t = Instant::now();
        let mut w = BufWriter::with_capacity(1 << 22, std::fs::File::create(&csv).unwrap());
        writeln!(w, "timestamp,temp,pressure,vibration,current,voltage,flow").unwrap();
        let base = 1735689600i64; // 2025-01-01
        let mut seed = 7u64;
        for i in 0..rows {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let r = (seed >> 33) as f64 / (1u64 << 31) as f64;
            let ts = chronos_engine::fmt_time(((base + i as i64) * 1000) as f64);
            let x = i as f64;
            writeln!(w, "{},{:.3},{:.2},{:.4},{:.3},{:.2},{:.2}", &ts[..19], 20.0 + 5.0 * (x / 13751.0).sin(), 1013.0 + r, r * 2.0 - 1.0 + if i % 500_000 == 0 { 30.0 } else { 0.0 }, 10.0 + (x / 3600.0).sin(), 230.0 + r, (x / 7200.0).sin().abs() * 50.0).unwrap();
        }
        w.flush().unwrap();
        println!("generated {} rows in {:.1}s", rows, t.elapsed().as_secs_f64());
    }
    let size = std::fs::metadata(&csv).unwrap().len();
    println!("csv size {:.2} GB, threads {}", size as f64 / 1e9, rayon::current_num_threads());
    let e = Engine::new();
    let noop = |_: &str, _: Value| {};
    let t = Instant::now();
    let Reply::Json(pv) = e.call("preview", json!({ "path": csv }), &noop).unwrap() else { panic!() };
    println!("preview {:.1} ms  format {} est rows {}", t.elapsed().as_secs_f64() * 1e3, pv["timeFormat"], pv["estimatedRows"]);
    for compact in [false, true] {
        let settings = json!({ "delimiter": ",", "hasHeader": true, "timeColumn": "timestamp", "timeFormat": pv["timeFormat"], "columns": ["temp","pressure","vibration","current","voltage","flow"], "compact": compact });
        let t = Instant::now();
        let Reply::Json(info) = e.call("import", json!({ "path": csv, "settings": settings, "job": "b" }), &noop).unwrap() else { panic!() };
        let secs = t.elapsed().as_secs_f64();
        println!("import compact={compact}: {:.2}s ({:.0} MB/s) rows {} mem {:.2} GB", secs, size as f64 / 1e6 / secs, info["rows"], info["bytes"].as_f64().unwrap() / 1e9);
        let id = info["id"].as_str().unwrap().to_string();
        let series: Vec<Value> = ["temp","pressure","vibration","current","voltage","flow"].iter().map(|c| json!({"source": id, "column": c})).collect();
        let (s0, s1) = (info["start"].as_f64().unwrap(), info["end"].as_f64().unwrap());
        for (label, a, b) in [("full", s0, s1), ("5%", s0 + (s1 - s0) * 0.3, s0 + (s1 - s0) * 0.35), ("1h", s0 + 3.6e6 * 1000.0, s0 + 3.6e6 * 1001.0)] {
            let t = Instant::now();
            let Reply::Bytes(bw) = e.call("window", json!({ "series": series, "start": a, "end": b, "maxPoints": 8000 }), &noop).unwrap() else { panic!() };
            let tw = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            e.call("stats", json!({ "series": series, "start": a, "end": b }), &noop).unwrap();
            println!("  window {label}: 6 series {:.2} ms ({} KB), stats {:.2} ms", tw, bw.len() / 1024, t.elapsed().as_secs_f64() * 1e3);
        }
        if !compact {
            let ws = dir.join("bench.chronos");
            let _ = std::fs::remove_file(&ws);
            let t = Instant::now();
            let Reply::Json(r) = e.call("save", json!({ "path": ws, "workspace": {"v": 1} }), &noop).unwrap() else { panic!() };
            println!("  save full: {:.2}s, file {:.2} GB", t.elapsed().as_secs_f64(), r["fileSize"].as_f64().unwrap() / 1e9);
            let t = Instant::now();
            let Reply::Json(r) = e.call("save", json!({ "path": ws, "workspace": {"v": 2} }), &noop).unwrap() else { panic!() };
            println!("  save layout-only: {:.1} ms, wrote {} bytes", t.elapsed().as_secs_f64() * 1e3, r["written"]);
            let e2 = Engine::new();
            let t = Instant::now();
            let Reply::Json(o) = e2.call("open", json!({ "path": ws }), &noop).unwrap() else { panic!() };
            println!("  open from cache: {:.2}s, reprocessed {}", t.elapsed().as_secs_f64(), o["reprocessed"]);
        }
        e.call("remove", json!({ "id": id }), &noop).unwrap();
    }
}
