import type { StartTranscriptionInput, TranscriptionMode } from '@weave-in/transcribe';

export const SETTINGS_STORAGE_KEY = 'weave-in:settings';
export const MAX_SELECTED_LANGUAGES = 4;

export interface LanguageOption {
  code: string;
  native: string;
  label: string;
}

/** Curated BCP-47 codes accepted by both transcription providers. */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = Object.freeze([
  { code: 'en-US', native: 'English', label: 'English (US)' },
  { code: 'en-GB', native: 'English', label: 'English (UK)' },
  { code: 'cmn-Hant-TW', native: '繁體中文', label: 'Mandarin (Taiwan)' },
  { code: 'cmn-Hans-CN', native: '简体中文', label: 'Mandarin (China)' },
  { code: 'yue-Hant-HK', native: '粵語', label: 'Cantonese (Hong Kong)' },
  { code: 'ja-JP', native: '日本語', label: 'Japanese' },
  { code: 'ko-KR', native: '한국어', label: 'Korean' },
  { code: 'es-ES', native: 'Español', label: 'Spanish' },
  { code: 'fr-FR', native: 'Français', label: 'French' },
  { code: 'de-DE', native: 'Deutsch', label: 'German' },
  { code: 'pt-BR', native: 'Português', label: 'Portuguese (Brazil)' },
  { code: 'it-IT', native: 'Italiano', label: 'Italian' },
  { code: 'nl-NL', native: 'Nederlands', label: 'Dutch' },
  { code: 'ru-RU', native: 'Русский', label: 'Russian' },
  { code: 'pl-PL', native: 'Polski', label: 'Polish' },
  { code: 'tr-TR', native: 'Türkçe', label: 'Turkish' },
  { code: 'ar-EG', native: 'العربية', label: 'Arabic' },
  { code: 'hi-IN', native: 'हिन्दी', label: 'Hindi' },
  { code: 'id-ID', native: 'Bahasa Indonesia', label: 'Indonesian' },
  { code: 'vi-VN', native: 'Tiếng Việt', label: 'Vietnamese' },
  { code: 'th-TH', native: 'ไทย', label: 'Thai' },
]);

export interface MeetingSettings {
  captionsEnabled: boolean;
  languageCodes: string[];
  mode: TranscriptionMode;
}

export const DEFAULT_SETTINGS: Readonly<MeetingSettings> = Object.freeze({
  captionsEnabled: true,
  languageCodes: [],
  mode: 'VERBATIM',
});

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Accepts anything found in storage and returns a complete, valid settings object. */
export function parseSettings(value: unknown): MeetingSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const known = new Set(LANGUAGE_OPTIONS.map((option) => option.code));
  const languageCodes = Array.isArray(record['languageCodes'])
    ? [...new Set(record['languageCodes'].filter((code): code is string => typeof code === 'string' && known.has(code)))]
        .slice(0, MAX_SELECTED_LANGUAGES)
    : [];
  const mode = record['mode'] === 'SMART' ? 'SMART' : 'VERBATIM';
  const captionsEnabled = typeof record['captionsEnabled'] === 'boolean' ? record['captionsEnabled'] : true;
  return { captionsEnabled, languageCodes, mode };
}

export function readSettings(storage: StorageLike | null = browserStorage()): MeetingSettings {
  if (!storage) return { ...DEFAULT_SETTINGS, languageCodes: [] };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    return parseSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS, languageCodes: [] };
  }
}

export function writeSettings(settings: MeetingSettings, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parseSettings(settings)));
  } catch {
    // Storage may be unavailable; settings then live only for this page session.
  }
}

/** The subset of settings the transcription session needs at start time. */
export function transcriptionOverrides(settings: MeetingSettings): StartTranscriptionInput {
  return { languageCodes: [...settings.languageCodes], mode: settings.mode };
}

export function transcriptionSettingsChanged(before: MeetingSettings, after: MeetingSettings): boolean {
  return (
    before.captionsEnabled !== after.captionsEnabled ||
    before.mode !== after.mode ||
    before.languageCodes.length !== after.languageCodes.length ||
    before.languageCodes.some((code, index) => after.languageCodes[index] !== code)
  );
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
