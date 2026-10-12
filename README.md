<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Quill">
</p>

<h1 align="center">Quill</h1>

<h3 align="center">Say it. It's written.</h3>

<p align="center">
Private voice dictation that lives on your PC.<br>
Press <kbd>Win</kbd> + <kbd>Space</kbd>, speak, and your words appear wherever you type.
</p>

<p align="center">
  <a href="https://github.com/lsai-dev/quill-dictation/releases/latest"><b>Download for Windows&nbsp;↓</b></a>
</p>

<br>

---

<br>

## Speak anywhere.

One shortcut works in every app. Tap <kbd>Win</kbd> + <kbd>Space</kbd> to start and tap again to finish. Or hold it while you talk and let go. <kbd>Esc</kbd> cancels.

Your words land right at the cursor. Your clipboard is just as you left it.

<br>

## Your words, polished.

People don't speak in finished sentences. Quill's optional **Polishing** removes the *ums*, the stutters and the false starts. It fixes punctuation and capitals. Say *"at 3, no wait, at 4"* and you get *"at 4."*

Your meaning, tone, names and numbers stay exactly as you said them. Every result is checked before it's inserted. If anything doesn't pass, you get your words as spoken.

<p align="center">
  <img src="docs/cleanup-design.png" alt="Quill's first-run setup, the Models page in light and dark, and the Transcribing and Polishing states">
</p>

<br>

## Made for your PC.

Quill looks at your processor, memory and graphics card, then recommends the model that suits them. Setup is one guided step. Pick *Recommended* and you're done, or choose *Highest accuracy*, *Fastest* or *Lightest*.

When your graphics card is faster, Quill uses it. When it isn't, Quill quietly uses the processor. You never have to think about it.

<br>

## Fluent in more than one language.

Polishing speaks English and Spanish, with instructions tuned for each. Move between them mid-thought. Quill switches in milliseconds.

<br>

## A presence, not a window.

A small ribbon of pearlescent glass appears while you speak. It ripples with your voice, curls while it thinks, and settles when your words arrive. It never steals focus or covers your work.

Prefer less motion? Quill respects your Windows animation setting and tells the whole story through light alone.

<br>

## Always up to date.

Quill checks for new versions on its own. It downloads only what changed, never restarts while you're dictating, and keeps your settings and models exactly where they are.

<br>

---

<br>

## Private by design.

Your voice never leaves your PC.

Speech recognition and Polishing run entirely on your device. There's no account, no cloud and no fallback to a server. Recent dictations are kept in memory only and disappear when you quit.

Quill connects to the internet for two things: downloading the models you choose from Hugging Face, and checking GitHub for updates. That's it.

<br>

---

<br>

## System requirements

- Windows, 64-bit
- An internet connection for the first model download (models range from 57 MB to 3 GB)
- Polishing needs a processor with AVX2, or a graphics card with room for it. Without one, dictation works just the same.
- A graphics card with Vulkan support is used automatically when it helps. It isn't required.

Quill can't type into apps running as administrator, because Windows doesn't allow it.

<br>

## Build from source

You'll need Node 22+, Rust (stable), CMake and LLVM/libclang. The GPU engine also needs the [Vulkan SDK](https://vulkan.lunarg.com/).

```bash
npm install
npm run build:native   # native helper and CPU engine
npm run dev            # run Quill
npm test               # unit tests
npm run dist:win       # build the Windows installer
```

Architecture, the ribbon's design, model recommendations, Polishing, GPU builds and releases are covered in **[How Quill works](docs/technical.md)**. The cleanup model research is in [docs/cleanup-models.md](docs/cleanup-models.md), and the native engines are documented in [native/README.md](native/README.md).

<br>

## License

Quill is open source under the [MIT License](LICENSE).
