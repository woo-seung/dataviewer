//! Diagnostics: a small rotating log file in the app data folder and memory figures.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Log {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Log {
    pub fn new(dir: &Path) -> Self {
        Log { path: dir.join("chronos.log"), lock: Mutex::new(()) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(&self, msg: &str) {
        let _g = self.lock.lock();
        // keep the log small: start over past 2 MB (previous one kept as .old)
        if std::fs::metadata(&self.path).map(|m| m.len() > 2 << 20).unwrap_or(false) {
            let _ = std::fs::rename(&self.path, self.path.with_extension("log.old"));
        }
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let m = memory();
            let _ = writeln!(f, "{} [rss {} MB, free {} / {} MB] {}", crate::fmt_time(crate::now_ms() as f64), m.process_mb, m.available_mb, m.total_mb, msg);
        }
    }
}

#[derive(serde::Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total_mb: u64,
    pub available_mb: u64,
    pub process_mb: u64,
}

#[cfg(windows)]
pub fn memory() -> Memory {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut m = Memory::default();
    unsafe {
        let mut st: MEMORYSTATUSEX = std::mem::zeroed();
        st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut st) != 0 {
            m.total_mb = st.ullTotalPhys >> 20;
            m.available_mb = st.ullAvailPhys >> 20;
        }
        let mut pc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        pc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut pc, pc.cb) != 0 {
            m.process_mb = (pc.WorkingSetSize >> 20) as u64;
        }
    }
    m
}

#[cfg(not(windows))]
pub fn memory() -> Memory {
    let mut m = Memory::default();
    if let Ok(s) = std::fs::read_to_string("/proc/meminfo") {
        for l in s.lines() {
            let kb = |l: &str| l.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) >> 10;
            if l.starts_with("MemTotal:") {
                m.total_mb = kb(l);
            } else if l.starts_with("MemAvailable:") {
                m.available_mb = kb(l);
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string("/proc/self/statm") {
        let pages: u64 = s.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        m.process_mb = pages * 4096 >> 20;
    }
    m
}

/// Show a file in the OS file manager.
pub fn reveal(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn()?;
    }
    Ok(())
}
