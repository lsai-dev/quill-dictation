# Contributing to Quill

Thank you for helping make Quill better.

## Before you start

- **Found a bug?** [Open a bug report](../../issues/new?template=bug_report.yml). Steps to reproduce help the most.
- **Have an idea?** [Suggest a feature](../../issues/new?template=feature_request.yml). Tell us what you're trying to do, not just how.
- **Planning a larger change?** Open an issue first, so we can agree on the direction before you write code.

## Getting set up

You'll need Node 22+, Rust (stable), CMake and LLVM/libclang.

```bash
npm install
npm run build:native
npm run dev
```

GPU builds, the cleanup engine and the release process are covered in [How Quill works](docs/technical.md).

## Making a change

- Keep each pull request focused on one thing.
- Run `npm run typecheck` and `npm test` before you open it.
- Write commit messages that say what changed, in plain words.
- Respect what Quill stands for. It stays private, on-device and simple. Changes that send audio or text off the device won't be accepted.

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE).
