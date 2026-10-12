import { describe, expect, it } from 'vitest';
import { applyVoiceCommands, cleanTranscript, smartSpace } from '../src/shared/text';

describe('cleanTranscript', () => {
  it('removes whisper annotations', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript(' Hello there. [Music] ')).toBe('Hello there.');
    expect(cleanTranscript('(upbeat music) Meeting at noon.')).toBe('Meeting at noon.');
    expect(cleanTranscript('♪ la la ♪')).toBe('la la');
  });

  it('keeps genuine parentheticals', () => {
    expect(cleanTranscript('Ship it (after review) tomorrow.')).toBe('Ship it (after review) tomorrow.');
  });

  it('drops stock hallucinations', () => {
    expect(cleanTranscript(' Thanks for watching!')).toBe('');
    expect(cleanTranscript('Subtitles by the Amara.org community')).toBe('');
    expect(cleanTranscript('Thank you.', { speechMs: 200 })).toBe('');
  });

  it('keeps short phrases that were really spoken', () => {
    expect(cleanTranscript('Thank you.', { speechMs: 900 })).toBe('Thank you.');
  });

  it('collapses repetition loops', () => {
    expect(cleanTranscript('I think that I think that I think that I think that we should go.')).toBe('I think that we should go.');
  });

  it('applies voice commands', () => {
    expect(cleanTranscript('Hello. New paragraph. how are you?', { voiceCommands: true })).toBe('Hello.\n\nHow are you?');
    expect(applyVoiceCommands('First item, new line, second item')).toBe('First item\nSecond item');
  });
});

describe('smartSpace', () => {
  it('adds a space when continuing in the same window', () => {
    expect(smartSpace('Next sentence.', { sameTarget: true, lastChar: '.' })).toBe(' Next sentence.');
  });
  it('does nothing in a new window or after whitespace', () => {
    expect(smartSpace('Hi.', { sameTarget: false, lastChar: '.' })).toBe('Hi.');
    expect(smartSpace('Hi.', { sameTarget: true, lastChar: '\n' })).toBe('Hi.');
    expect(smartSpace(', and more', { sameTarget: true, lastChar: 'x' })).toBe(', and more');
  });
});
