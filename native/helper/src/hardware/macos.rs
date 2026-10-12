//! macOS sources (best effort, via `sysctl` / `vm_stat`). GPU enumeration is not
//! implemented; Apple Silicon always has an integrated GPU usable through Metal.

use super::{Gpu, Memory};
use std::process::Command;

fn sysctl(name: &str) -> Option<String> {
    let out = Command::new("/usr/sbin/sysctl").args(["-n", name]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

pub fn core_counts() -> Option<(usize, usize)> {
    let physical = sysctl("hw.physicalcpu")?.parse().ok()?;
    let logical = sysctl("hw.logicalcpu")?.parse().ok()?;
    Some((physical, logical))
}

pub fn memory() -> Option<Memory> {
    let total: u64 = sysctl("hw.memsize")?.parse().ok()?;
    Some(Memory { total, available: available_memory().unwrap_or(0).min(total) })
}

/// Free + inactive + speculative pages from `vm_stat`.
fn available_memory() -> Option<u64> {
    let out = Command::new("/usr/bin/vm_stat").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let page_size: u64 = text
        .lines()
        .next()?
        .split("page size of ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let pages = |key: &str| -> u64 {
        text.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|v| v.trim().trim_end_matches('.').parse().ok())
            .unwrap_or(0)
    };
    Some((pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page_size)
}

#[allow(dead_code)]
pub fn cpu_brand() -> Option<String> {
    sysctl("machdep.cpu.brand_string")
}

#[allow(dead_code)]
pub fn cpu_vendor() -> Option<String> {
    sysctl("machdep.cpu.vendor").or_else(|| Some("Apple".into()))
}

pub fn gpus() -> Vec<Gpu> {
    Vec::new()
}
