// Builds Quill's native sidecars and stages them in resources/bin.
//   node scripts/build-native.mjs            → quill-native + CPU engine
//   node scripts/build-native.mjs --vulkan   → also the Vulkan (GPU) engine (needs the Vulkan SDK)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const exe = process.platform === 'win32' ? '.exe' : '';
const native = join(process.cwd(), 'native');
const out = join(process.cwd(), 'resources', 'bin');
mkdirSync(out, { recursive: true });

const cargo = (args, targetDir) =>
  execFileSync('cargo', ['build', '--release', ...args], {
    cwd: native,
    stdio: 'inherit',
    env: { ...process.env, ...(targetDir ? { CARGO_TARGET_DIR: targetDir } : {}) },
  });

console.log('› Building quill-native and the CPU engine');
cargo(['-p', 'quill-native', '-p', 'quill-engine']);
copyFileSync(join(native, 'target', 'release', `quill-native${exe}`), join(out, `quill-native${exe}`));
copyFileSync(join(native, 'target', 'release', `quill-engine${exe}`), join(out, `quill-engine-cpu${exe}`));

if (process.argv.includes('--vulkan')) {
  console.log('› Building the Vulkan engine');
  const dir = join(native, 'target-vulkan');
  cargo(['-p', 'quill-engine', '--features', 'vulkan'], dir);
  copyFileSync(join(dir, 'release', `quill-engine${exe}`), join(out, `quill-engine-vulkan${exe}`));
}

for (const f of ['quill-native', 'quill-engine-cpu', 'quill-engine-vulkan']) {
  const p = join(out, f + exe);
  console.log(`  ${existsSync(p) ? '✓' : '·'} ${f}${exe}`);
}
