import { app } from 'electron';
import { cpus, freemem, totalmem, availableParallelism } from 'node:os';
import type { GpuInfo, HardwareProfile } from '../shared/types';
import type { NativeHelper } from './native';
import { log } from './log';

const VENDORS: Record<number, GpuInfo['vendor']> = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x1022: 'amd',
  0x8086: 'intel',
  0x106b: 'apple',
  0x5143: 'qualcomm',
  0x4d4f4351: 'qualcomm',
};

export function vendorFromId(id: number): GpuInfo['vendor'] {
  return VENDORS[id] ?? 'other';
}

/** Build a hardware profile, preferring the native probe (accurate VRAM via DXGI). */
export async function detectHardware(native: NativeHelper | null, vulkanEngineAvailable: boolean): Promise<HardwareProfile> {
  const hw = native ? await native.hardware() : null;
  const vulkan = vulkanEngineAvailable && (native ? await native.vulkanAvailable() : false);
  if (hw) {
    const f = hw.cpu.features ?? {};
    return {
      cpu: {
        brand: hw.cpu.brand?.trim() || cpus()[0]?.model || 'Processor',
        vendor: hw.cpu.vendor ?? '',
        physicalCores: hw.cpu.physical_cores || Math.max(1, Math.round(availableParallelism() / 2)),
        logicalCores: hw.cpu.logical_cores || availableParallelism(),
        avx2: !!f.avx2,
        avx512: !!f.avx512f,
        fma: !!f.fma,
        f16c: !!f.f16c,
        neon: !!f.neon,
      },
      totalMemory: hw.memory?.total || totalmem(),
      availableMemory: hw.memory?.available || freemem(),
      gpus: (hw.gpus ?? [])
        .filter((g) => !g.software)
        .map((g) => ({
          name: cleanGpuName(g.name),
          vendor: vendorFromId(g.vendor_id),
          vramBytes: g.dedicated_vram || 0,
          sharedBytes: g.shared_memory || 0,
          integrated: !!g.integrated,
        })),
      vulkan,
      platform: process.platform,
      source: 'native',
    };
  }
  return fallbackHardware(vulkan);
}

async function fallbackHardware(vulkan: boolean): Promise<HardwareProfile> {
  const logical = availableParallelism();
  const gpus: GpuInfo[] = [];
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId: number; deviceId: number; deviceString?: string }[] };
    for (const d of info.gpuDevice ?? []) {
      const vendor = vendorFromId(d.vendorId);
      gpus.push({
        name: d.deviceString || `${vendor === 'other' ? 'Graphics' : vendor.toUpperCase()} GPU`,
        vendor,
        vramBytes: 0, // unknown without the native probe — be conservative
        sharedBytes: 0,
        integrated: vendor === 'intel',
      });
    }
  } catch (e) {
    log.warn(`gpu info: ${(e as Error).message}`);
  }
  return {
    cpu: {
      brand: cpus()[0]?.model?.trim() || 'Processor',
      vendor: '',
      physicalCores: Math.max(1, Math.round(logical / 2)),
      logicalCores: logical,
      avx2: process.arch === 'x64',
      avx512: false,
      fma: process.arch === 'x64',
      f16c: process.arch === 'x64',
      neon: process.arch === 'arm64',
    },
    totalMemory: totalmem(),
    availableMemory: freemem(),
    gpus,
    vulkan,
    platform: process.platform,
    source: 'fallback',
  };
}

function cleanGpuName(n: string) {
  return (n || 'Graphics').replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' ').trim();
}
