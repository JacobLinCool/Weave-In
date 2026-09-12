import {
  DEFAULT_OPTIONS,
  type StartTranscriptionInput,
  type TranscriptionMode,
  type TranscriptionOptions,
  type TranscriptionProvider,
} from './contracts';
import { TranscribeError } from './errors';

const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
export const MAX_LANGUAGE_CODES = 5;
const MAX_VOCABULARY_ITEMS = 100;
const MAX_VOCABULARY_ITEM_LENGTH = 100;

export function normalizeOptions(
  options: Partial<TranscriptionOptions> | undefined,
): TranscriptionOptions {
  return resolveOptions(DEFAULT_OPTIONS, options);
}

export function resolveOptions(
  base: TranscriptionOptions,
  overrides: StartTranscriptionInput | undefined,
): TranscriptionOptions {
  const input = overrides ?? {};
  return {
    provider:
      input.provider === undefined
        ? normalizeProvider(base.provider)
        : normalizeProvider(input.provider),
    languageCodes:
      input.languageCodes === undefined
        ? normalizeLanguageCodes(base.languageCodes)
        : normalizeLanguageCodes(input.languageCodes),
    mode: input.mode === undefined ? normalizeMode(base.mode) : normalizeMode(input.mode),
    customVocabulary:
      input.customVocabulary === undefined
        ? normalizeVocabulary(base.customVocabulary)
        : normalizeVocabulary(input.customVocabulary),
  };
}

function normalizeProvider(value: unknown): TranscriptionProvider {
  if (value === 'gemini' || value === 'openai') return value;
  throw new TranscribeError(
    'INVALID_TRANSCRIPTION_PROVIDER',
    'provider must be gemini or openai.',
  );
}

function normalizeLanguageCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TranscribeError(
      'INVALID_LANGUAGE_CODES',
      'languageCodes must be an array of BCP-47 language codes; an empty array enables automatic detection.',
    );
  }
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (normalized.length > MAX_LANGUAGE_CODES) {
    throw new TranscribeError(
      'INVALID_LANGUAGE_CODES',
      `languageCodes may contain at most ${MAX_LANGUAGE_CODES} items.`,
    );
  }
  const invalid = normalized.find((code) => !LANGUAGE_CODE_PATTERN.test(code));
  if (invalid !== undefined) {
    throw new TranscribeError(
      'INVALID_LANGUAGE_CODES',
      'languageCodes must contain valid BCP-47 values such as en-US or cmn-Hant-TW.',
    );
  }
  return normalized;
}

function normalizeMode(value: unknown): TranscriptionMode {
  if (value === 'SMART' || value === 'VERBATIM') return value;
  throw new TranscribeError(
    'INVALID_TRANSCRIPTION_MODE',
    'mode must be SMART or VERBATIM.',
  );
}

function normalizeVocabulary(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TranscribeError(
      'INVALID_CUSTOM_VOCABULARY',
      'customVocabulary must be an array of strings.',
    );
  }
  if (value.length > MAX_VOCABULARY_ITEMS) {
    throw new TranscribeError(
      'INVALID_CUSTOM_VOCABULARY',
      `customVocabulary may contain at most ${MAX_VOCABULARY_ITEMS} items.`,
    );
  }

  const normalized = [...new Set(value.map((item) => item.trim()))].filter(Boolean);
  if (normalized.some((item) => item.length > MAX_VOCABULARY_ITEM_LENGTH)) {
    throw new TranscribeError(
      'INVALID_CUSTOM_VOCABULARY',
      `Each custom vocabulary item must be ${MAX_VOCABULARY_ITEM_LENGTH} characters or fewer.`,
    );
  }
  return normalized;
}
