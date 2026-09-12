import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_SELECTED_LANGUAGES,
  parseSettings,
  readSettings,
  SETTINGS_STORAGE_KEY,
  transcriptionOverrides,
  transcriptionSettingsChanged,
  writeSettings,
} from '../src/settings';

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
  removeItem(key: string): void { this.items.delete(key); }
}

describe('meeting settings', () => {
  it('falls back to defaults for missing, malformed, or unknown values', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ languageCodes: ['en-US', 'klingon', 'en-US', 42], mode: 'loud', captionsEnabled: 'yes' }))
      .toEqual({ captionsEnabled: true, languageCodes: ['en-US'], mode: 'VERBATIM' });
    const tooMany = parseSettings({ languageCodes: ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES'] });
    expect(tooMany.languageCodes).toHaveLength(MAX_SELECTED_LANGUAGES);
  });

  it('round-trips through storage and survives corrupt JSON', () => {
    const storage = new FakeStorage();
    writeSettings({ captionsEnabled: false, languageCodes: ['cmn-Hant-TW', 'en-US'], mode: 'SMART' }, storage);
    expect(readSettings(storage)).toEqual({ captionsEnabled: false, languageCodes: ['cmn-Hant-TW', 'en-US'], mode: 'SMART' });
    storage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(readSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('maps to transcription overrides and detects relevant changes', () => {
    const base = { captionsEnabled: true, languageCodes: ['ja-JP'], mode: 'VERBATIM' as const };
    expect(transcriptionOverrides(base)).toEqual({ languageCodes: ['ja-JP'], mode: 'VERBATIM' });
    expect(transcriptionSettingsChanged(base, { ...base })).toBe(false);
    expect(transcriptionSettingsChanged(base, { ...base, languageCodes: ['ja-JP', 'en-US'] })).toBe(true);
    expect(transcriptionSettingsChanged(base, { ...base, mode: 'SMART' })).toBe(true);
    expect(transcriptionSettingsChanged(base, { ...base, captionsEnabled: false })).toBe(true);
  });
});
