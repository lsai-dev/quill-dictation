//! Windows sources: GetLogicalProcessorInformationEx, GlobalMemoryStatusEx, DXGI, registry.

use super::gpu;
use super::{Gpu, Memory};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GlobalMemoryStatusEx, RelationProcessorCore, GROUP_AFFINITY,
    MEMORYSTATUSEX, SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
};

/// (physical, logical) core counts across all processor groups.
pub fn core_counts() -> Option<(usize, usize)> {
    let mut len = 0u32;
    // SAFETY: a null buffer with a length pointer is the documented size query.
    let _ = unsafe { GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut len) };
    if len == 0 {
        return None;
    }
    // u64 storage keeps the records 8-byte aligned (they contain usize masks).
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    let base = buf.as_mut_ptr().cast::<u8>();
    // SAFETY: `buf` holds at least `len` writable bytes.
    unsafe {
        GetLogicalProcessorInformationEx(RelationProcessorCore, Some(base.cast()), &mut len).ok()?;
    }

    let (mut physical, mut logical) = (0usize, 0usize);
    let mut offset = 0usize;
    let header = std::mem::offset_of!(SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX, Anonymous);
    while offset + header <= len as usize {
        // SAFETY: `offset` stays inside the bytes the API wrote; records are variable-sized
        // and read unaligned to be safe.
        unsafe {
            let rec = base.add(offset).cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>();
            let size = std::ptr::addr_of!((*rec).Size).read_unaligned() as usize;
            if size == 0 {
                break;
            }
            if std::ptr::addr_of!((*rec).Relationship).read_unaligned() == RelationProcessorCore {
                physical += 1;
                let proc_rel = std::ptr::addr_of!((*rec).Anonymous.Processor);
                let groups = std::ptr::addr_of!((*proc_rel).GroupCount).read_unaligned() as usize;
                let masks = std::ptr::addr_of!((*proc_rel).GroupMask).cast::<GROUP_AFFINITY>();
                for g in 0..groups {
                    let end = masks.add(g + 1).cast::<u8>();
                    if end > base.add(len as usize) {
                        break;
                    }
                    logical += masks.add(g).read_unaligned().Mask.count_ones() as usize;
                }
            }
            offset += size;
        }
    }
    (physical > 0).then(|| (physical, logical.max(physical)))
}

pub fn memory() -> Option<Memory> {
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: `status` is a properly initialised MEMORYSTATUSEX with dwLength set.
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    Some(Memory { total: status.ullTotalPhys, available: status.ullAvailPhys })
}

/// Hardware adapters as seen by DXGI. Software adapters are omitted.
pub fn gpus() -> Vec<Gpu> {
    // SAFETY: plain COM factory creation; the interface is released on drop.
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(f) => f,
        Err(e) => {
            crate::protocol::log!("DXGI unavailable: {e}");
            return Vec::new();
        }
    };
    let mut gpus = Vec::new();
    // EnumAdapters1 fails with DXGI_ERROR_NOT_FOUND past the last adapter.
    for index in 0u32.. {
        // SAFETY: enumerating adapters of a valid factory.
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else { break };
        // SAFETY: GetDesc1 on a valid adapter.
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
        let name = wide_to_string(&desc.Description);
        if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 || gpu::is_software(desc.VendorId, &name) {
            continue;
        }
        let dedicated = desc.DedicatedVideoMemory as u64;
        gpus.push(Gpu {
            integrated: gpu::is_integrated(desc.VendorId, &name, Some(dedicated)),
            vendor: gpu::vendor_slug(desc.VendorId),
            name,
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            dedicated_vram: dedicated,
            shared_memory: desc.SharedSystemMemory as u64,
            software: false,
        });
    }
    gpus
}

/// CPU name from the registry (used where CPUID is unavailable, e.g. Windows on Arm).
#[allow(dead_code)]
pub fn cpu_brand() -> Option<String> {
    cpu_registry_value(w!("ProcessorNameString"))
}

#[allow(dead_code)]
pub fn cpu_vendor() -> Option<String> {
    cpu_registry_value(w!("VendorIdentifier"))
}

fn cpu_registry_value(value: PCWSTR) -> Option<String> {
    let key = w!("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0");
    let mut buf = [0u16; 256];
    let mut size = std::mem::size_of_val(&buf) as u32;
    // SAFETY: `buf`/`size` describe a valid writable buffer; RRF_RT_REG_SZ guarantees
    // NUL termination.
    let status = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, key, value, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size))
    };
    (status == ERROR_SUCCESS).then(|| wide_to_string(&buf)).filter(|s| !s.is_empty())
}

fn wide_to_string(wide: &[u16]) -> String {
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end]).trim().to_string()
}
