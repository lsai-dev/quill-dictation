<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Quill">
</p>

<h1 align="center">Quill</h1>
<p align="center"><b>Your voice, written — instantly and privately.</b><br>
Press <kbd>Win</kbd> + <kbd>Space</kbd>, speak, and your words appear wherever you type. Everything runs on your PC.</p>

---

## What it is

Quill is a voice-dictation app for Windows that uses **only local AI models**. There is no account, no cloud, no upload: audio is captured, transcribed by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on your own processor or graphics card, and the text is inserted at your cursor.

- **Win + Space, anywhere.** Tap to start and tap to finish — or hold while you speak and release. `Esc` cancels.
- **Tuned to your PC.** Quill reads your processor, memory and graphics card and recommends the model that suits them, with clear picks for *Recommended*, *Highest accuracy*, *Fastest* and *Lightest*.
- **It just works.** The GPU engine is used automatically when it's clearly faster; if it can't start (or ever crashes) Quill falls back to the CPU without you noticing. Downloads resume and are verified. Your clipboard is restored after inserting.
- **A living indicator.** A small ribbon of pearlescent glass that responds to your voice.

## The ribbon

Quill's identity is a tiny floating ribbon of folded glass — pearl on the outside, lit by a soft violet light within. It's a real 3D surface: the ribbon is deformed in a vertex shader, normals come from the deformed surface, and the material combines thin-film iridescence, Fresnel reflection of a studio environment, and violet light that leaks out wherever the glass bends or twists. Overlapping folds are composited with depth peeling so translucent layers stack correctly, and it casts a soft projected shadow.

It is always **one continuous object**: every state is a set of spring targets (SwiftUI-style `response`/`dampingFraction` springs), so transitions are never cuts — only the same thing changing shape.

| State | What you see |
|---|---|
| **Activating** | A point of light unfolds into the ribbon along its own path, with a soft spring. |
| **Listening** | The ribbon holds its shape with a barely-there breath. A steady **● Listening** label makes the open mic unmistakable. |
| **Speaking** | Your voice launches waves from the centre that travel out to the tips. Quiet speech makes delicate ripples; louder speech makes broader bends. A short voice-energy history drives the waves, so syllables visibly travel. |
| **Processing** | It curls into a loose loop; a glint of light circles the fold. |
| **Text inserted** | One satisfying settle, a single sweep of light, then it folds back into a point and is gone. |
| **Error** | A small head-shake and a plain-language message. |

Design rules it follows: a stable footprint (it animates inside a fixed window and never moves over your work); controls (cancel ✕, finish ■) emerge beside it only on hover; the window is click-through everywhere else and never steals focus; one material, one accent colour. **Reduced motion** (Windows "Animation effects" off, or Settings › Motion) keeps the silhouette still and carries every state through light alone. Machines without WebGL2 — or whose GPU context is lost — get an SVG ribbon with the same choreography, swapped in mid-flight.

Try it in a browser: `npx vite`, then open `http://localhost:5199/playground.html`.

## Hardware-aware recommendations

Quill estimates, for every model, the time to transcribe a typical 10-second sentence and the memory it needs on *your* machine (calibrated against whisper.cpp benchmarks; see `src/shared/recommend.ts`):

- **Device:** a discrete GPU with ≥ 2 GB VRAM and a Vulkan driver → GPU; integrated graphics → CPU (it's usually not faster); the choice can be overridden in Settings.
- **Fit:** models must fit comfortably in VRAM (GPU) or in a share of available RAM (CPU).
- **Picks:** *Recommended* balances accuracy, latency, memory and download size; *Highest accuracy* is the most accurate model that still answers within ~4 s; *Fastest* and *Lightest* do what they say.

Examples: an RTX 3060 gets *Large · Compact* on the GPU in ~0.7 s; a 4-core Iris Xe ultrabook gets *Small · Compact* on the CPU; a 4 GB Celeron laptop gets *Tiny*.

## Architecture

```
Electron main (TypeScript)               native/ (Rust)
├─ dictation state machine               ├─ quill-native   ← Win32: WH_KEYBOARD_LL hook (Win+Space,
├─ hotkey (native hook / fallback)       │                    Start-menu suppression, Esc capture),
├─ engine manager ─ GPU→CPU fallback ──▶ │                    SendInput paste/type, DXGI GPU probe
├─ model downloads (resume + SHA-256)    └─ quill-engine   ← whisper.cpp (CPU and Vulkan builds),
├─ hardware profile + recommendations                         JSON-lines protocol over stdio
└─ windows: overlay (transparent, non-activating, click-through) · app (Mica)

Renderers (Vite + TypeScript, no framework)
├─ overlay: ribbon (WebGL2) + AudioWorklet capture at 16 kHz + synthesized sounds
└─ app: onboarding, Home, Models, Settings
```

Captured audio is trimmed with an adaptive voice-activity detector and level-normalized before transcription; nothing is sent when no speech is detected. Transcripts are cleaned of Whisper's non-speech annotations and stock hallucinations, support "new line" / "new paragraph", and get smart spacing when you keep dictating into the same window.

## Building

Requirements: Node 22+, Rust (stable), and — for the GPU engine on Windows — the [Vulkan SDK](https://vulkan.lunarg.com/).

```bash
npm install
npm run build:native            # quill-native + CPU engine → resources/bin
npm run build:native -- --vulkan  # also the Vulkan GPU engine
npm run dev                     # run Quill with hot-reloading renderers
npm test                        # unit tests (recommendations, audio, text)
npm run dist:win                # Windows installer → release/
```

The GitHub Actions workflow builds the native sidecars (CPU + Vulkan) and the installer on `windows-latest` and uploads it as an artifact.

## Project layout

```
src/main/        Electron main process
src/preload/     contextBridge APIs (sandboxed renderers)
src/renderer/    ribbon/, overlay/, app/, playground/
src/shared/      models catalog, recommendations, audio + text processing (unit-tested)
native/          Rust sidecars
resources/       icons (rendered from the real ribbon: `npm run icons`)
```

## Privacy

Speech recognition runs entirely on your device. Quill makes exactly one kind of network request: downloading a model you choose, from the whisper.cpp model repository. Recent dictations are kept in memory only and vanish when Quill quits.

## License

MIT
