import { describe, expect, it } from 'vitest';

import { DEFAULT_OPTIONS } from '../src/contracts';
import { normalizeOptions, resolveOptions } from '../src/options';

describe('transcription options', () => {
  it('defaults to automatic language detection and accepts several BCP-47 codes', () => {
    expect(normalizeOptions(undefined).languageCodes).toEqual([]);
    expect(resolveOptions(DEFAULT_OPTIONS, { languageCodes: [' en-US', 'cmn-Hant-TW', 'en-US', ''] }).languageCodes)
      .toEqual(['en-US', 'cmn-Hant-TW']);
  });

  it('rejects malformed or excessive language lists', () => {
    expect(() => resolveOptions(DEFAULT_OPTIONS, { languageCodes: ['english'] })).toThrow(/BCP-47/u);
    expect(() => resolveOptions(DEFAULT_OPTIONS, { languageCodes: 'en-US' as unknown as string[] })).toThrow(/array/u);
    expect(() => resolveOptions(DEFAULT_OPTIONS, { languageCodes: ['en', 'fr', 'de', 'es', 'it', 'ja'] })).toThrow(/at most/u);
  });

  it('does not let a start override mutate the base options', () => {
    const base = normalizeOptions({ languageCodes: ['ja-JP'] });
    const resolved = resolveOptions(base, { mode: 'SMART' });
    resolved.languageCodes.push('ko-KR');
    expect(base.languageCodes).toEqual(['ja-JP']);
    expect(resolved.mode).toBe('SMART');
  });
});
