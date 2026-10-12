# Quill native sidecars

Two small Rust programs that the Electron app spawns and talks to over stdin/stdout:

| Crate | Binary | Job |
| --- | --- | --- |
| `engine/` (`quill-engine`) | `quill-engine` | Local speech-to-text with whisper.cpp (via `whisper-rs` 0.16 / whisper.cpp 1.8.3) |
| `helper/` (`quill-native`) | `quill-native` | Windows integration: global hotkey hook, Escape capture, paste/type injection, foreground window; plus a cross-platform hardware probe |
| `cleanup/` (`quill-cleanup`) | `quill-cleanup` | Local transcript cleanup with a small language model (llama.cpp via `llama-cpp-2` 0.1.159) |

`common/protocol.rs` (line-delimited JSON framing) is compiled into both via `#[path]`.

## Building

Prerequisites: Rust ≥ 1.85, CMake, a C/C++ toolchain (MSVC Build Tools on Windows) and
libclang for `bindgen` (on Windows: install LLVM and set `LIBCLANG_PATH` if it is not found).

```sh
cd native
cargo build --release                                   # both binaries, CPU engine
cargo build --release -p quill-engine --features vulkan  # Vulkan engine (needs the Vulkan SDK; VULKAN_SDK set on Windows)
cargo build --release -p quill-engine --features cuda    # CUDA engine (needs the CUDA toolkit)
cargo test                                               # unit tests (run on any OS)
# The cleanup engine: build with an AVX2 baseline (llama.cpp takes its CPU kernels from
# Rust's target features) in its own target directory.
RUSTFLAGS="-C target-feature=+avx,+avx2,+fma,+f16c,+bmi2" CARGO_TARGET_DIR=target-cleanup cargo build --release -p quill-cleanup
RUSTFLAGS="-C target-feature=+avx,+avx2,+fma,+f16c,+bmi2" CARGO_TARGET_DIR=target-cleanup cargo build --release -p quill-cleanup --features vulkan
```

Ship the Vulkan and CPU engines as separate binaries: the app should start the Vulkan one
only when `quill-native` reports `vulkan_available: true`, and fall back to the CPU one if
it exits before its `ready` event or `load` with `"gpu": true` fails.

**Portable builds.** whisper.cpp compiles with `-march=native` by default, which produces
binaries that can crash with an illegal instruction on older CPUs. For binaries you
distribute, build with `GGML_NATIVE=OFF` in the environment (any `GGML_*`, `WHISPER_*`,
`CMAKE_*` variable is forwarded to CMake). That targets AVX2 + FMA + F16C (Haswell / Zen
and newer). For older CPUs, an extra build with `GGML_NATIVE=OFF GGML_AVX2=OFF GGML_FMA=OFF
GGML_F16C=OFF GGML_BMI2=OFF` works; `hardware.cpu.features.avx2` tells the app which to use.

## Protocol

Shared framing for both binaries:

* **Requests** — stdin, one UTF-8 JSON object per line (`\n`; a trailing `\r` is
  tolerated, blank lines are ignored, lines over 8 MiB are rejected). If the object has
  `"bytes": N`, exactly N raw bytes follow the newline. Those bytes are always consumed,
  even when the request is rejected, so the stream stays in sync.
* **Replies** — stdout, one line each: `{"id":<echoed>,"ok":true,...}` or
  `{"id":<echoed or null>,"ok":false,"error":"..."}`. Malformed JSON gets `"id":null`.
* **Events** — stdout lines with an `"event"` field and no `"id"`.
* stdout carries protocol lines only (flushed per line); all logging goes to stderr.
* Both exit with status 0 on stdin EOF or after replying to `{"cmd":"shutdown"}`.
* Unknown commands and invalid arguments return `ok:false`. Both binaries also accept
  `{"cmd":"ping"}` → `{"ok":true}`.

### quill-engine

Startup: `{"event":"ready","version":"0.1.0","backend":"cpu"|"vulkan"|"cuda","system_info":"WHISPER : ... | CPU : ... AVX2 = 1 ...","whisper_version":"1.8.3"}`

| Request | Reply fields |
| --- | --- |
| `{"cmd":"load","model":"/abs/ggml-base.en.bin","gpu":true,"flash_attn":true,"threads":0}` | `load_ms`, `warmup_ms`, `gpu` (true only if requested *and* compiled in *and* a device exists), `device` (GPU name or `"CPU"`), `threads`, `multilingual` |
| `{"cmd":"transcribe","bytes":N,"language":"en"\|"auto"\|"<code or name>","translate":false,"prompt":"","beam_size":0}` + N bytes of f32 LE mono 16 kHz PCM | `text`, `segments` (`[{"text","no_speech_prob"}]`), `language` (detected or used), `audio_ms`, `process_ms` |
| `{"cmd":"unload"}` | `was_loaded` |
| `{"cmd":"info"}` | `version`, `backend`, `system_info`, `model` (path or null), `gpu`, `device`, `threads` |
| `{"cmd":"shutdown"}` | — |

* `load` rejects missing / non-ggml files with a clear message (keeping the current
  model), otherwise frees the current model before loading the new one, then runs a 1 s
  silent warm-up (Vulkan compiles its pipelines on first use). A failed load leaves no
  model loaded.
  `threads: 0` = physical cores, clamped to 1..=8. Defaults: `gpu` true, `flash_attn` true.
  With `gpu: true` in a GPU build and no GPU device present, `load` fails (whisper.cpp
  would silently fall back to the CPU); retry with `gpu: false`.
* `transcribe`: `beam_size` 0/1 = greedy, >1 = beam search (capped at 8). Input shorter
  than 1 s is padded with silence; NaN/inf samples become silence, samples are clamped
  to [-1, 1]. Limits: N must be a non-zero multiple of 4 and at most 10 minutes of audio
  (38,400,000 bytes). English-only models always use `en` and never translate.
  Errors: `no model loaded`, `audio too long ...`, `unsupported language ...`, etc.
* Decoding settings: no timestamps, `no_context`, suppress blank + non-speech tokens,
  temperature fallback as in whisper.cpp.
* `QUILL_ENGINE_LOG=off|error|warn|info|debug` (default `info`) controls how much
  whisper.cpp/ggml logging reaches stderr.

### quill-native

Startup: `{"event":"ready","version":"0.1.0","platform":"windows"|"linux"|"macos","hotkey":"win+space"}`

Events (Windows): `{"event":"hotkey","state":"down"}`, `{"event":"hotkey","state":"up"}`,
`{"event":"escape"}`, and `{"event":"hook_error","message":"..."}` if the keyboard hook
cannot be installed (config commands retry the installation).

| Request | Reply fields | Non-Windows |
| --- | --- | --- |
| `{"cmd":"set_hotkey","hotkey":"win+space"}` | `hotkey` (canonical), `enabled`, `capture_escape`, `hook_active` | error* |
| `{"cmd":"set_hotkey_enabled","enabled":true}` | same | error |
| `{"cmd":"capture_escape","enabled":true}` | same | error |
| `{"cmd":"paste"}` | `waited_ms`, `modifiers_held`, `keystrokes` | error |
| `{"cmd":"type","text":"Hello\nworld"}` | `waited_ms`, `modifiers_held`, `keystrokes` | error |
| `{"cmd":"hardware"}` | `cpu{brand,vendor,physical_cores,logical_cores,features{sse4_2,avx,avx2,fma,f16c,avx512f,neon}}`, `memory{total,available}`, `gpus[{name,vendor_id,device_id,vendor,dedicated_vram,shared_memory,integrated,software}]` | ✓ |
| `{"cmd":"foreground"}` | `handle` (HWND as decimal string), `title`, `process` (e.g. `notepad.exe`) | nulls |
| `{"cmd":"vulkan_available"}` | `available` | ✓ |
| `{"cmd":"shutdown"}` | — | ✓ |

\* "unsupported on this platform" (an invalid hotkey spec is reported as such first).

* **Hotkey grammar**: `+`-separated, case-insensitive; modifiers `win|ctrl|alt|shift`;
  exactly one of `space`, `a`–`z`, `0`–`9`, `f1`–`f24`, `enter`, `tab`, `capslock`,
  `insert`, `pause`, `scrolllock`, `backquote`. Keys that type text (`space`, letters,
  digits, `enter`, `tab`, `backquote`) need at least one modifier. Default `win+space`.
* **Matching**: the main key must go down while exactly the required modifiers are held
  (either side). The press is swallowed and reported once (auto-repeat is swallowed
  silently); the release, or releasing a required modifier first, reports `up`. After a
  combo, releasing any of its modifiers is preceded by an injected tap of the unassigned
  VK 0xE8, so Windows does not see a lone modifier tap (Start menu for Win, menu bar for
  Alt, layout/IME switching for Shift combos). Win+Space never reaches Windows.
* **Escape capture**: while enabled, Escape presses are swallowed and reported once.
* **paste** sends Ctrl+V; **type** sends `KEYEVENTF_UNICODE` per UTF-16 unit (Enter for
  `\n`/`\r\n`, Tab for `\t`, other control characters dropped), 64 keystrokes per
  `SendInput`. Both first wait up to 400 ms for the user to release Win/Alt/Shift (and
  Ctrl, for `type`). Windows blocks injection into elevated windows (UIPI) without
  reporting an error.
* **hardware**: software adapters (Microsoft Basic Render Driver) are omitted, so
  `software` is always false. `integrated` = Intel without an Arc model number, AMD
  "… Graphics" APUs, Qualcomm/Arm/Apple, or < 512 MiB dedicated memory. Linux reads
  procfs/sysfs, names GPUs via `nvidia-smi` or `pci.ids`; macOS uses `sysctl` and reports
  no GPUs.

### quill-cleanup

Startup: `{"event":"ready","version":"0.1.0","backend":"cpu"|"vulkan","system_info":"CPU : ... AVX2 = 1 ..."}`

Model work runs on a worker thread; the main thread keeps reading stdin, so `cancel`
takes effect between two decoding steps (milliseconds). Requests are handled in order.

| Request | Reply fields |
| --- | --- |
| `{"cmd":"load","model":"/abs/model.gguf","gpu":false,"threads":0,"ctx":4096}` | `load_ms`, `gpu`, `device`, `threads`, `ctx`, `recurrent`, `model_bytes`, `params` |
| `{"cmd":"prime","prefix":[segments]}` | `prefix_tokens`, `prime_ms` |
| `{"cmd":"clean","prefix":[segments],"prompt":[segments],"lookup":"transcript","max_tokens":512,"stop":["..."]}` | `text`, `stop` (`eog` \| `stop` \| `limit`), `prompt_tokens`, `cached_tokens`, `generated_tokens`, `drafted_tokens`, `accepted_tokens`, `prompt_ms`, `generate_ms`, `process_ms` |
| `{"cmd":"cancel","target":<request id>}` | — (the target, and anything queued with a lower id, fails with `"cancelled"`) |
| `{"cmd":"unload"}` / `{"cmd":"info"}` / `{"cmd":"ping"}` / `{"cmd":"shutdown"}` | as for quill-engine |

* **Segments** are `{"text": "...", "special": bool}`. Special segments are tokenized
  with control-token parsing (chat-template markers); others never are, so text from a
  transcript can't forge a turn.
* **Prefix caching**: `prefix` (instructions + examples) is evaluated once and reused
  while it's unchanged — by trimming the KV cache back to it for dense models, or by
  restoring a state snapshot for recurrent/hybrid models (which can't trim).
  `QUILL_CLEANUP_SNAPSHOT=1` forces the snapshot path (tests).
* **Decoding** is greedy. For dense models, drafts are proposed by matching the output
  against `lookup` (prompt-lookup decoding) and verified in one batch; rejected tokens
  are removed from the KV cache. The output is identical to plain greedy decoding. The
  draft length adapts to the measured cost of a verification step and the acceptance
  rate.
* `load` refuses non-GGUF or missing files without letting go of the current model.
  With `gpu: true` in a Vulkan build and no GPU device, `load` fails (llama.cpp would
  quietly use the CPU); the app then starts the CPU build.
* `QUILL_CLEANUP_LOG=off|error|warn|info|debug` (default `warn`) controls llama.cpp's
  logging on stderr.
