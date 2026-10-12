import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { newest, nextVersion, notesFor, shipsChanges } from '../scripts/release-version.mjs';

describe('automatic release version', () => {
  it('finds the newest release tag numerically', () => {
    expect(newest(['v0.2.0', 'v0.10.0', 'v0.9.3', 'not-a-version', ''])).toBe('0.10.0');
    expect(newest([])).toBeNull();
  });

  it('bumps the patch number after the newest release', () => {
    expect(nextVersion('0.2.0', '0.2.0')).toBe('0.2.1');
    expect(nextVersion('0.2.1', '0.2.4')).toBe('0.2.5');
  });

  it('keeps a version someone bumped by hand', () => {
    expect(nextVersion('0.3.0', '0.2.7')).toBe('0.3.0');
    expect(nextVersion('0.2.1', '0.2.0')).toBe('0.2.1');
    expect(nextVersion('0.1.0', null)).toBe('0.1.0');
  });

  it('only releases when something that ships changed', () => {
    expect(shipsChanges(['README.md', 'docs/technical.md', '.github/workflows/build.yml', 'test/text.test.ts'])).toBe(false);
    expect(shipsChanges(['resources/release-notes.md'])).toBe(false);
    expect(shipsChanges(['src/renderer/ribbon/touch.ts'])).toBe(true);
    expect(shipsChanges(['package.json'])).toBe(true);
  });

  it('writes notes from commit subjects', () => {
    expect(notesFor('0.2.2', ['Fix the tray icon', '', 'Faster startup'])).toBe('**Quill 0.2.2**\n\n- Fix the tray icon\n- Faster startup\n');
  });
});
