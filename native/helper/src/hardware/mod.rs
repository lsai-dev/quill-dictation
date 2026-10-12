//! Hardware probe for model recommendations: CPU, memory and GPUs.
//!
//! Every part is best effort: a failing sub-probe yields defaults (or an empty GPU list),
//! never an error for the whole command.

mod cpu;
mod gpu;

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod os;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod os;
#[cfg(windows)]
#[path = "windows.rs"]
mod os;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "fallback.rs"]
mod os;

use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct Hardware {
    pub cpu: Cpu,
    pub memory: Memory,
    pub gpus: Vec<Gpu>,
}

#[derive(Serialize, Debug)]
pub struct Cpu {
    pub brand: String,
    pub vendor: String,
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub features: Features,
}

/// Instruction-set extensions relevant to whisper.cpp's CPU backend.
#[derive(Serialize, Debug, Default)]
pub struct Features {
    pub sse4_2: bool,
    pub avx: bool,
    pub avx2: bool,
    pub fma: bool,
    pub f16c: bool,
    pub avx512f: bool,
    pub neon: bool,
}

/// Physical memory in bytes.
#[derive(Serialize, Debug, Default, Clone, Copy)]
pub struct Memory {
    pub total: u64,
    pub available: u64,
}

#[derive(Serialize, Debug, Clone)]
pub struct Gpu {
    pub name: String,
    /// PCI vendor id (e.g. 4318 = 0x10DE NVIDIA, 4098 = 0x1002 AMD, 32902 = 0x8086 Intel).
    pub vendor_id: u32,
    pub device_id: u32,
    /// Convenience classification of `vendor_id`:
    /// `nvidia` | `amd` | `intel` | `apple` | `qualcomm` | `other`.
    pub vendor: &'static str,
    /// Dedicated video memory in bytes (0 if unknown).
    pub dedicated_vram: u64,
    /// System memory the GPU can borrow, in bytes (0 if unknown).
    pub shared_memory: u64,
    pub integrated: bool,
    /// Always false: software adapters (e.g. "Microsoft Basic Render Driver") are omitted.
    pub software: bool,
}

pub fn probe() -> Hardware {
    Hardware { cpu: cpu::probe(), memory: os::memory().unwrap_or_default(), gpus: os::gpus() }
}
