//! Platforms without a dedicated probe: CPUID / std only.

use super::{Gpu, Memory};

pub fn core_counts() -> Option<(usize, usize)> {
    None
}

pub fn memory() -> Option<Memory> {
    None
}

#[allow(dead_code)]
pub fn cpu_brand() -> Option<String> {
    None
}

#[allow(dead_code)]
pub fn cpu_vendor() -> Option<String> {
    None
}

pub fn gpus() -> Vec<Gpu> {
    Vec::new()
}
