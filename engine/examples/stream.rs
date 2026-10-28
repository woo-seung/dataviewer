//! Time the incremental importer on a CSV: `cargo run --release --example stream -- file.csv`
use chronos_engine::csv::{preview, ImportSettings, StreamImport};
use std::io::Read;

fn main() {
    let path = std::env::args().nth(1).expect("csv path");
    let pv = preview(std::path::Path::new(&path), None).unwrap();
    let settings = ImportSettings {
        delimiter: pv.delimiter.clone(),
        has_header: pv.has_header,
        time_column: pv.header[pv.time_column].clone(),
        time_format: pv.time_format,
        columns: pv.numeric_columns.iter().map(|&i| pv.header[i].clone()).collect(),
        compact: false,
    };
    let mut f = std::fs::File::open(&path).unwrap();
    let total = f.metadata().unwrap().len();
    let t = std::time::Instant::now();
    let mut st = StreamImport::new(settings, total);
    let mut buf = vec![0u8; 16 << 20];
    loop {
        let n = f.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        st.feed(&buf[..n]).unwrap();
    }
    let r = st.finish().unwrap();
    println!("{} rows x {} cols in {:.2}s", r.time.len(), r.columns.len(), t.elapsed().as_secs_f64());
}
