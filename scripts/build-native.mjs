// Builds Quill's native sidecars and stages them in resources/bin.
//   node scripts/build-native.mjs            → quill-native + CPU engine
//   node scripts/build-native.mjs --vulkan   → also the Vulkan (GPU) engine (needs the Vulkan SDK)
//   node scripts/build-native.mjs --compat   → also an engine for CPUs without AVX2 (older/budget PCs)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, parse } from 'node:path';

const exe = process.platform === 'win32' ? '.exe' : '';
const native = join(process.cwd(), 'native');
const out = join(process.cwd(), 'resources', 'bin');
mkdirSync(out, { recursive: true });

// whisper.cpp defaults to -march=native, which would bake this machine's newest
// instructions (AVX-512, AMX…) into the engine and crash it on other CPUs.
// Distributable builds target a portable AVX2/FMA/F16C baseline instead.
// Set QUILL_NATIVE_CPU=1 for a build tuned to this machine only.
const portable = process.env.QUILL_NATIVE_CPU ? {} : { GGML_NATIVE: 'OFF' };

const cargo = (args, targetDir, extraEnv = {}) =>
  execFileSync('cargo', ['build', '--release', ...args], {
    cwd: native,
    stdio: 'inherit',
    env: { ...process.env, ...portable, ...extraEnv, ...(targetDir ? { CARGO_TARGET_DIR: targetDir } : {}) },
  });

console.log('› Building quill-native and the CPU engine');
cargo(['-p', 'quill-native', '-p', 'quill-engine']);
copyFileSync(join(native, 'target', 'release', `quill-native${exe}`), join(out, `quill-native${exe}`));
copyFileSync(join(native, 'target', 'release', `quill-engine${exe}`), join(out, `quill-engine-cpu${exe}`));

if (process.argv.includes('--vulkan')) {
  console.log('› Building the Vulkan engine');
  // ggml builds its shader compiler as a deeply nested CMake project whose paths
  // overflow Windows' 260-character limit from inside the repo, so on Windows the
  // Vulkan build uses a short directory at the drive root.
  const dir = process.env.QUILL_VULKAN_TARGET_DIR ?? (process.platform === 'win32' ? join(parse(native).root, 'qv') : join(native, 'target-vulkan'));
  // ggml builds its shader compiler as a nested CMake project; under the Visual
  // Studio generator that nested configure can't find the compiler. Ninja (run
  // from an MSVC developer environment) handles both levels.
  const generator = process.platform === 'win32' && !process.env.CMAKE_GENERATOR ? { CMAKE_GENERATOR: 'Ninja' } : {};
  cargo(['-p', 'quill-engine', '--features', 'vulkan'], dir, generator);
  copyFileSync(join(dir, 'release', `quill-engine${exe}`), join(out, `quill-engine-vulkan${exe}`));
}

if (process.argv.includes('--compat')) {
  console.log('› Building the compatibility engine (no AVX/AVX2/FMA/F16C)');
  const dir = join(native, 'target-compat');
  execFileSync('cargo', ['build', '--release', '-p', 'quill-engine'], {
    cwd: native,
    stdio: 'inherit',
    env: {
      ...process.env,
      CARGO_TARGET_DIR: dir,
      GGML_NATIVE: 'OFF',
      GGML_AVX: 'OFF',
      GGML_AVX2: 'OFF',
      GGML_AVX512: 'OFF',
      GGML_FMA: 'OFF',
      GGML_F16C: 'OFF',
      GGML_BMI2: 'OFF',
    },
  });
  copyFileSync(join(dir, 'release', `quill-engine${exe}`), join(out, `quill-engine-compat${exe}`));
}

for (const f of ['quill-native', 'quill-engine-cpu', 'quill-engine-compat', 'quill-engine-vulkan']) {
  const p = join(out, f + exe);
  console.log(`  ${existsSync(p) ? '✓' : '·'} ${f}${exe}`);
}
