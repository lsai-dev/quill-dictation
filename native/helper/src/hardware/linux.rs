//! Linux sources: procfs, sysfs, pci.ids and (optionally) nvidia-smi.

use super::gpu::{self, VENDOR_NVIDIA};
use super::{Gpu, Memory};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// (physical, logical) core counts from /proc/cpuinfo.
pub fn core_counts() -> Option<(usize, usize)> {
    let text = fs::read_to_string("/proc/cpuinfo").ok()?;
    let counts = parse_cpuinfo_cores(&text);
    // No "physical id"/"core id" lines (common on Arm and some VMs): ask sysfs.
    counts.or_else(|| {
        let logical = text.lines().filter(|l| key_of(l) == "processor").count();
        (logical > 0).then(|| (sysfs_physical_cores().unwrap_or(logical), logical))
    })
}

/// Physical/logical counts from unique (physical id, core id) pairs.
fn parse_cpuinfo_cores(text: &str) -> Option<(usize, usize)> {
    let mut logical = 0;
    let mut cores = HashSet::new();
    let (mut phys, mut core): (Option<&str>, Option<&str>) = (None, None);
    // A blank line ends each processor block; chain one to flush the last block.
    for line in text.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if let (Some(p), Some(c)) = (phys.take(), core.take()) {
                cores.insert((p, c));
            }
            continue;
        }
        match key_of(line) {
            "processor" => logical += 1,
            "physical id" => phys = value_of(line),
            "core id" => core = value_of(line),
            _ => {}
        }
    }
    (logical > 0 && !cores.is_empty()).then_some((cores.len(), logical))
}

fn sysfs_physical_cores() -> Option<usize> {
    let mut cores = HashSet::new();
    for entry in fs::read_dir("/sys/devices/system/cpu").ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.strip_prefix("cpu").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
            continue;
        }
        let topo = entry.path().join("topology");
        let package = read_trimmed(&topo.join("physical_package_id")).unwrap_or_default();
        if let Some(core) = read_trimmed(&topo.join("core_id")) {
            cores.insert((package, core));
        }
    }
    (!cores.is_empty()).then_some(cores.len())
}

pub fn memory() -> Option<Memory> {
    parse_meminfo(&fs::read_to_string("/proc/meminfo").ok()?)
}

fn parse_meminfo(text: &str) -> Option<Memory> {
    let kib = |key: &str| -> Option<u64> {
        text.lines()
            .find(|l| key_of(l) == key)
            .and_then(value_of)
            .and_then(|v| v.split_whitespace().next())
            .and_then(|n| n.parse::<u64>().ok())
            .map(|n| n * 1024)
    };
    let total = kib("MemTotal")?;
    // MemAvailable exists since Linux 3.14; approximate it on older kernels.
    let available = kib("MemAvailable")
        .or_else(|| Some(kib("MemFree")? + kib("Buffers").unwrap_or(0) + kib("Cached").unwrap_or(0)))
        .unwrap_or(0);
    Some(Memory { total, available: available.min(total) })
}

/// CPU name for non-x86 machines (x86 uses CPUID).
#[allow(dead_code)]
pub fn cpu_brand() -> Option<String> {
    let text = fs::read_to_string("/proc/cpuinfo").ok()?;
    ["model name", "Hardware", "Model", "cpu model"]
        .iter()
        .find_map(|k| text.lines().find(|l| key_of(l) == *k).and_then(value_of))
        .map(str::to_string)
        .or_else(|| fs::read_to_string("/proc/device-tree/model").ok().map(|s| s.trim_matches('\0').trim().to_string()))
}

#[allow(dead_code)]
pub fn cpu_vendor() -> Option<String> {
    let text = fs::read_to_string("/proc/cpuinfo").ok()?;
    ["vendor_id", "CPU implementer"]
        .iter()
        .find_map(|k| text.lines().find(|l| key_of(l) == *k).and_then(value_of))
        .map(str::to_string)
}

/// GPUs from /sys/class/drm, named via nvidia-smi (NVIDIA) or pci.ids when available.
pub fn gpus() -> Vec<Gpu> {
    let Ok(entries) = fs::read_dir("/sys/class/drm") else { return Vec::new() };
    let mut cards: Vec<(u32, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n: u32 = name.strip_prefix("card")?.parse().ok()?; // skip connectors like card0-HDMI-A-1
            Some((n, e.path().join("device")))
        })
        .collect();
    cards.sort();

    let mut nvidia = nvidia_smi().into_iter();
    let mut seen = HashSet::new();
    let mut gpus = Vec::new();
    for (_, dev) in cards {
        // Two cards can share a PCI device (e.g. render/display splits); report it once.
        if let Ok(real) = fs::canonicalize(&dev) {
            if !seen.insert(real) {
                continue;
            }
        }
        let (Some(vendor_id), Some(device_id)) = (read_hex(&dev.join("vendor")), read_hex(&dev.join("device"))) else {
            continue; // e.g. simpledrm framebuffers have no PCI identity
        };
        let mut vram = read_trimmed(&dev.join("mem_info_vram_total")).and_then(|s| s.parse::<u64>().ok());
        let shared = read_trimmed(&dev.join("mem_info_gtt_total")).and_then(|s| s.parse::<u64>().ok());
        let mut name = None;
        if vendor_id == VENDOR_NVIDIA {
            if let Some((n, mem)) = nvidia.next() {
                name = Some(n);
                vram = vram.or(Some(mem));
            }
        }
        let name = name
            .or_else(|| pci_ids_name(vendor_id, device_id))
            .unwrap_or_else(|| format!("{} GPU 0x{device_id:04x}", gpu::vendor_display(vendor_id)));
        if gpu::is_software(vendor_id, &name) {
            continue;
        }
        gpus.push(Gpu {
            integrated: gpu::is_integrated(vendor_id, &name, vram),
            vendor: gpu::vendor_slug(vendor_id),
            name,
            vendor_id,
            device_id,
            dedicated_vram: vram.unwrap_or(0),
            shared_memory: shared.unwrap_or(0),
            software: false,
        });
    }
    gpus
}

/// `(name, total memory in bytes)` per NVIDIA GPU, in nvidia-smi order.
fn nvidia_smi() -> Vec<(String, u64)> {
    let out = run_with_timeout(
        Command::new("nvidia-smi").args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]),
        Duration::from_secs(3),
    );
    out.map(|text| parse_nvidia_smi(&text)).unwrap_or_default()
}

fn parse_nvidia_smi(text: &str) -> Vec<(String, u64)> {
    text.lines()
        .filter_map(|line| {
            let (name, mib) = line.rsplit_once(',')?;
            let mib: u64 = mib.trim().parse().ok()?;
            Some((name.trim().to_string(), mib * 1024 * 1024))
        })
        .collect()
}

/// Runs a command, returning its stdout if it exits successfully within `timeout`.
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Looks the device up in the system's PCI ID database (pciutils / hwdata).
fn pci_ids_name(vendor_id: u32, device_id: u32) -> Option<String> {
    let path = ["/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids", "/usr/share/pci.ids"]
        .into_iter()
        .find(|p| Path::new(p).exists())?;
    let reader = BufReader::new(fs::File::open(path).ok()?);
    lookup_pci_ids(reader.lines().map_while(Result::ok), vendor_id, device_id)
}

fn lookup_pci_ids(lines: impl Iterator<Item = String>, vendor_id: u32, device_id: u32) -> Option<String> {
    let vendor_prefix = format!("{vendor_id:04x}  ");
    let device_prefix = format!("\t{device_id:04x}  ");
    let mut vendor_name: Option<String> = None;
    for line in lines {
        match &vendor_name {
            None => {
                if let Some(rest) = line.strip_prefix(&vendor_prefix) {
                    vendor_name = Some(rest.trim().to_string());
                }
            }
            Some(vendor) => {
                if !line.starts_with('\t') && !line.starts_with('#') && !line.trim().is_empty() {
                    return None; // next vendor: device not listed
                }
                if let Some(rest) = line.strip_prefix(&device_prefix) {
                    let short = match gpu::vendor_display(vendor_id) {
                        "Unknown" => vendor.as_str(),
                        known => known,
                    };
                    return Some(format!("{short} {}", device_label(rest.trim())));
                }
            }
        }
    }
    None
}

/// "GA106 [GeForce RTX 3060 Lock Hash Rate]" -> "GeForce RTX 3060 Lock Hash Rate".
fn device_label(raw: &str) -> &str {
    match (raw.find('['), raw.rfind(']')) {
        (Some(a), Some(b)) if b > a + 1 => &raw[a + 1..b],
        _ => raw,
    }
}

fn key_of(line: &str) -> &str {
    line.split(':').next().unwrap_or("").trim()
}

fn value_of(line: &str) -> Option<&str> {
    line.split_once(':').map(|(_, v)| v.trim()).filter(|v| !v.is_empty())
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_hex(path: &Path) -> Option<u32> {
    let s = read_trimmed(path)?;
    u32::from_str_radix(s.trim_start_matches("0x"), 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpuinfo_with_smt() {
        let mut text = String::new();
        // 1 socket, 2 cores, 2 threads per core
        for (cpu, core) in [(0, 0), (1, 1), (2, 0), (3, 1)] {
            text += &format!("processor\t: {cpu}\nmodel name\t: Test CPU\nphysical id\t: 0\ncore id\t\t: {core}\n\n");
        }
        assert_eq!(parse_cpuinfo_cores(&text), Some((2, 4)));
    }

    #[test]
    fn cpuinfo_two_sockets_without_trailing_blank_line() {
        let text = "processor : 0\nphysical id : 0\ncore id : 0\n\nprocessor : 1\nphysical id : 1\ncore id : 0";
        assert_eq!(parse_cpuinfo_cores(text), Some((2, 2)));
    }

    #[test]
    fn cpuinfo_without_topology() {
        assert_eq!(parse_cpuinfo_cores("processor : 0\nBogoMIPS : 50\n\nprocessor : 1\n"), None);
    }

    #[test]
    fn meminfo() {
        let m = parse_meminfo("MemTotal:       16303428 kB\nMemFree:  100 kB\nMemAvailable:   15000000 kB\n").unwrap();
        assert_eq!(m.total, 16_303_428 * 1024);
        assert_eq!(m.available, 15_000_000 * 1024);
        let old = parse_meminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 10 kB\nCached: 40 kB\n").unwrap();
        assert_eq!(old.available, 150 * 1024);
        assert!(parse_meminfo("nothing").is_none());
    }

    #[test]
    fn nvidia_smi_output() {
        let parsed = parse_nvidia_smi("NVIDIA GeForce RTX 3060, 12288\nNVIDIA RTX A6000, 49140\ngarbage\n");
        assert_eq!(parsed, vec![
            ("NVIDIA GeForce RTX 3060".to_string(), 12288 * 1024 * 1024),
            ("NVIDIA RTX A6000".to_string(), 49140 * 1024 * 1024),
        ]);
    }

    #[test]
    fn pci_ids_lookup() {
        let db = "# comment\n10de  NVIDIA Corporation\n\t2503  GA106 [GeForce RTX 3060]\n\t\t1043 87f4  Sub\n\
                  \t2504  GA106 [GeForce RTX 3060 Lock Hash Rate]\n1234  Other Vendor\n\t2505  Thing\n";
        let lines = || db.lines().map(str::to_string);
        assert_eq!(lookup_pci_ids(lines(), 0x10de, 0x2504).as_deref(), Some("NVIDIA GeForce RTX 3060 Lock Hash Rate"));
        assert_eq!(lookup_pci_ids(lines(), 0x10de, 0x2505), None);
        assert_eq!(lookup_pci_ids(lines(), 0x1234, 0x2505).as_deref(), Some("Other Vendor Thing"));
    }

    #[test]
    fn live_probe_does_not_panic() {
        let _ = core_counts();
        let m = memory().expect("procfs meminfo");
        assert!(m.total > 0 && m.available <= m.total);
        let _ = gpus();
    }
}
