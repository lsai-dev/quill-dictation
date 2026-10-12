//! OS-independent GPU classification helpers.

#![allow(dead_code)] // not every platform probe uses every helper

pub const VENDOR_NVIDIA: u32 = 0x10DE;
pub const VENDOR_AMD: u32 = 0x1002;
pub const VENDOR_AMD_ALT: u32 = 0x1022;
pub const VENDOR_INTEL: u32 = 0x8086;
pub const VENDOR_APPLE: u32 = 0x106B;
pub const VENDOR_QUALCOMM: u32 = 0x5143;
/// "QCOM" as reported by DXGI on Windows on Arm.
pub const VENDOR_QUALCOMM_ACPI: u32 = 0x4D4F_4351;
pub const VENDOR_ARM: u32 = 0x13B5;
/// Microsoft's software / remote-display adapters.
pub const VENDOR_MICROSOFT: u32 = 0x1414;

const MIB: u64 = 1024 * 1024;
/// Adapters with less dedicated memory than this are treated as integrated.
pub const INTEGRATED_VRAM_THRESHOLD: u64 = 512 * MIB;

pub fn vendor_slug(vendor_id: u32) -> &'static str {
    match vendor_id {
        VENDOR_NVIDIA => "nvidia",
        VENDOR_AMD | VENDOR_AMD_ALT => "amd",
        VENDOR_INTEL => "intel",
        VENDOR_APPLE => "apple",
        VENDOR_QUALCOMM | VENDOR_QUALCOMM_ACPI => "qualcomm",
        _ => "other",
    }
}

pub fn vendor_display(vendor_id: u32) -> &'static str {
    match vendor_id {
        VENDOR_NVIDIA => "NVIDIA",
        VENDOR_AMD | VENDOR_AMD_ALT => "AMD",
        VENDOR_INTEL => "Intel",
        VENDOR_APPLE => "Apple",
        VENDOR_QUALCOMM | VENDOR_QUALCOMM_ACPI => "Qualcomm",
        VENDOR_ARM => "Arm",
        _ => "Unknown",
    }
}

/// Integrated-GPU heuristic.
///
/// * Intel: integrated unless it is a discrete Arc part (name has an Arc model number
///   such as A770/B580; Meteor Lake's iGPU is just "Intel Arc Graphics").
/// * AMD: APUs are named "... Graphics" ("AMD Radeon(TM) Graphics", "Radeon 780M Graphics").
/// * Qualcomm / Arm / Apple: always integrated.
/// * Anything reporting less than 512 MiB of dedicated memory.
pub fn is_integrated(vendor_id: u32, name: &str, dedicated_vram: Option<u64>) -> bool {
    if dedicated_vram.is_some_and(|v| v < INTEGRATED_VRAM_THRESHOLD) {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    match vendor_id {
        VENDOR_INTEL => !(lower.contains("arc") && has_arc_model_number(&lower)),
        VENDOR_AMD | VENDOR_AMD_ALT => lower.ends_with("graphics") || lower.contains(" graphics "),
        VENDOR_QUALCOMM | VENDOR_QUALCOMM_ACPI | VENDOR_ARM | VENDOR_APPLE => true,
        _ => false,
    }
}

/// True if the (lower-case) name contains a token like `a770`, `a380m` or `b580`.
fn has_arc_model_number(lower: &str) -> bool {
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| {
            let b = tok.as_bytes();
            b.len() >= 4
                && matches!(b[0], b'a' | b'b' | b'c')
                && b[1..4].iter().all(u8::is_ascii_digit)
                && b[4..].iter().all(u8::is_ascii_alphabetic)
        })
}

/// Software rasterisers and remote-display adapters, which are useless for inference.
pub fn is_software(vendor_id: u32, name: &str) -> bool {
    vendor_id == VENDOR_MICROSOFT || name.to_ascii_lowercase().contains("basic render driver")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * MIB;

    #[test]
    fn integrated_heuristic() {
        // Intel
        assert!(is_integrated(VENDOR_INTEL, "Intel(R) UHD Graphics 770", Some(128 * MIB)));
        assert!(is_integrated(VENDOR_INTEL, "Intel(R) Iris(R) Xe Graphics", None));
        assert!(is_integrated(VENDOR_INTEL, "Intel(R) Arc(TM) Graphics", Some(128 * MIB)));
        assert!(is_integrated(VENDOR_INTEL, "Meteor Lake-P [Intel Arc Graphics]", None));
        assert!(!is_integrated(VENDOR_INTEL, "Intel(R) Arc(TM) A770 Graphics", Some(16 * GIB)));
        assert!(!is_integrated(VENDOR_INTEL, "DG2 [Arc A380]", None));
        assert!(!is_integrated(VENDOR_INTEL, "Intel(R) Arc(TM) B580 Graphics", Some(12 * GIB)));
        // AMD
        assert!(is_integrated(VENDOR_AMD, "AMD Radeon(TM) Graphics", Some(512 * MIB)));
        assert!(is_integrated(VENDOR_AMD, "AMD Radeon 780M Graphics", Some(2 * GIB)));
        assert!(is_integrated(VENDOR_AMD, "AMD Radeon(TM) Vega 8 Graphics", Some(512 * MIB)));
        assert!(!is_integrated(VENDOR_AMD, "AMD Radeon RX 7900 XTX", Some(24 * GIB)));
        assert!(!is_integrated(VENDOR_AMD, "AMD Radeon RX 6400", Some(4 * GIB)));
        // NVIDIA and small-VRAM fallback
        assert!(!is_integrated(VENDOR_NVIDIA, "NVIDIA GeForce RTX 3060", Some(12 * GIB)));
        assert!(is_integrated(0x1234, "Mystery GPU", Some(64 * MIB)));
        assert!(is_integrated(VENDOR_QUALCOMM_ACPI, "Qualcomm(R) Adreno(TM) X1-85 GPU", Some(GIB)));
    }

    #[test]
    fn vendors_and_software() {
        assert_eq!(vendor_slug(4318), "nvidia");
        assert_eq!(vendor_slug(0x1002), "amd");
        assert_eq!(vendor_slug(0x8086), "intel");
        assert_eq!(vendor_slug(0xABCD), "other");
        assert!(is_software(VENDOR_MICROSOFT, "Microsoft Basic Render Driver"));
        assert!(!is_software(VENDOR_NVIDIA, "NVIDIA GeForce RTX 4090"));
    }
}
