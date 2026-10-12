import type { GpuInfo, HardwareProfile } from '../src/shared/types';

const GiB = 1024 ** 3;

export function machine(p: {
  cores: number;
  threads?: number;
  ramGb: number;
  availGb?: number;
  avx2?: boolean;
  avx512?: boolean;
  brand?: string;
  gpus?: GpuInfo[];
  vulkan?: boolean;
}): HardwareProfile {
  return {
    cpu: {
      brand: p.brand ?? 'Generic CPU',
      vendor: 'GenuineIntel',
      physicalCores: p.cores,
      logicalCores: p.threads ?? p.cores * 2,
      avx2: p.avx2 ?? true,
      avx512: p.avx512 ?? false,
      fma: true,
      f16c: true,
      neon: false,
    },
    totalMemory: p.ramGb * GiB,
    availableMemory: (p.availGb ?? p.ramGb * 0.55) * GiB,
    gpus: p.gpus ?? [],
    vulkan: p.vulkan ?? true,
    platform: 'win32',
    source: 'native',
  };
}

export const gpu = (name: string, vendor: GpuInfo['vendor'], vramGb: number, integrated = false): GpuInfo => ({
  name, vendor, vramBytes: vramGb * GiB, sharedBytes: 8 * GiB, integrated,
});

export const MACHINES = {
  gamingDesktop: machine({ cores: 8, ramGb: 32, brand: 'AMD Ryzen 7 5800X 8-Core Processor', gpus: [gpu('NVIDIA GeForce RTX 3060', 'nvidia', 12)] }),
  ultrabook: machine({ cores: 4, threads: 8, ramGb: 16, brand: '11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz', gpus: [gpu('Intel(R) Iris(R) Xe Graphics', 'intel', 0.125, true)] }),
  budgetLaptop: machine({ cores: 2, threads: 4, ramGb: 4, availGb: 1.2, brand: 'Intel(R) Celeron(R) N4500 @ 1.10GHz', avx2: false, gpus: [gpu('Intel(R) UHD Graphics', 'intel', 0.125, true)] }),
  workstation: machine({ cores: 16, ramGb: 64, brand: 'AMD Ryzen 9 7950X 16-Core Processor', avx512: true, gpus: [gpu('NVIDIA GeForce RTX 4090', 'nvidia', 24)] }),
  midDesktopNoGpu: machine({ cores: 6, ramGb: 16, brand: 'Intel(R) Core(TM) i5-12400' }),
  smallGpu: machine({ cores: 6, ramGb: 16, brand: 'Intel(R) Core(TM) i5-10400F', gpus: [gpu('NVIDIA GeForce GTX 1650', 'nvidia', 4)] }),
  gpuNoVulkan: machine({ cores: 8, ramGb: 16, gpus: [gpu('NVIDIA GeForce RTX 3070', 'nvidia', 8)], vulkan: false }),
};
