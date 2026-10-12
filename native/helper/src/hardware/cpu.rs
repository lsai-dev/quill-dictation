//! CPU identification: CPUID on x86, OS sources elsewhere.

use super::{os, Cpu, Features};

pub fn probe() -> Cpu {
    let (brand, vendor) = identify();
    let logical_fallback = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let (physical, logical) = os::core_counts().unwrap_or((logical_fallback, logical_fallback));
    let logical = logical.max(1);
    Cpu {
        brand: brand.unwrap_or_else(|| "Unknown CPU".into()),
        vendor: vendor.unwrap_or_else(|| "unknown".into()),
        physical_cores: physical.clamp(1, logical),
        logical_cores: logical,
        features: features(),
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn identify() -> (Option<String>, Option<String>) {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::__cpuid;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::__cpuid;

    // `__cpuid` is safe on newer toolchains; the `unsafe` keeps older ones compiling.
    #[allow(unused_unsafe)]
    // SAFETY: CPUID is available on every x86-64 CPU and every x86 CPU Rust supports.
    let cpuid = |leaf: u32| unsafe { __cpuid(leaf) };

    let leaf0 = cpuid(0);
    let mut vendor = Vec::with_capacity(12);
    for reg in [leaf0.ebx, leaf0.edx, leaf0.ecx] {
        vendor.extend_from_slice(&reg.to_le_bytes());
    }
    let vendor = clean(&vendor);

    let brand = if cpuid(0x8000_0000).eax >= 0x8000_0004 {
        let mut bytes = Vec::with_capacity(48);
        for leaf in 0x8000_0002..=0x8000_0004u32 {
            let r = cpuid(leaf);
            for reg in [r.eax, r.ebx, r.ecx, r.edx] {
                bytes.extend_from_slice(&reg.to_le_bytes());
            }
        }
        clean(&bytes)
    } else {
        None
    };
    (brand.or_else(os::cpu_brand), vendor)
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn identify() -> (Option<String>, Option<String>) {
    (os::cpu_brand(), os::cpu_vendor())
}

/// Trims NULs and padding, collapsing internal runs of spaces.
#[cfg_attr(not(any(target_arch = "x86", target_arch = "x86_64")), allow(dead_code))]
fn clean(bytes: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(bytes);
    let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    (!collapsed.is_empty()).then_some(collapsed)
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn features() -> Features {
    Features {
        sse4_2: std::is_x86_feature_detected!("sse4.2"),
        avx: std::is_x86_feature_detected!("avx"),
        avx2: std::is_x86_feature_detected!("avx2"),
        fma: std::is_x86_feature_detected!("fma"),
        f16c: std::is_x86_feature_detected!("f16c"),
        avx512f: std::is_x86_feature_detected!("avx512f"),
        neon: false,
    }
}

#[cfg(target_arch = "aarch64")]
fn features() -> Features {
    Features { neon: std::arch::is_aarch64_feature_detected!("neon"), ..Features::default() }
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
fn features() -> Features {
    Features::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_cpuid_strings() {
        assert_eq!(clean(b"  Intel(R) Core(TM) i7   CPU\0\0\0").as_deref(), Some("Intel(R) Core(TM) i7 CPU"));
        assert_eq!(clean(b"\0\0\0\0"), None);
    }

    #[test]
    fn probe_is_sane() {
        let cpu = probe();
        assert!(cpu.logical_cores >= 1);
        assert!(cpu.physical_cores >= 1 && cpu.physical_cores <= cpu.logical_cores);
        assert!(!cpu.brand.is_empty());
        #[cfg(target_arch = "x86_64")]
        {
            assert!(cpu.features.sse4_2 || !cpu.features.avx2, "AVX2 implies SSE4.2");
            assert!(!cpu.features.neon);
            assert!(!cpu.vendor.is_empty() && cpu.vendor != "unknown");
        }
    }
}
