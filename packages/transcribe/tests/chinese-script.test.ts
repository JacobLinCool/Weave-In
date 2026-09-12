import { describe, expect, it } from 'vitest';
import dictionary from 'opencc-js/dict/STCharacters';

import { prefersTraditionalChinese, toTraditionalCharacters } from '../src/chinese-script';

describe('Traditional Chinese language preference', () => {
  it.each([
    ['cmn-Hant-TW'], ['cmn-Hant-TW', 'en-US'], ['zh-Hant'], ['zh-TW'],
    ['zh-HK'], ['zh-MO'], ['yue-Hant-HK'], ['CMN-hANT-tw'], ['zh-cmn-Hant-TW'],
    ['zh-Hant-CN'], ['zh-TW-u-nu-hanidec'],
  ])('enables character conversion for %j', (...languageCodes) => {
    expect(prefersTraditionalChinese(languageCodes)).toBe(true);
  });

  it.each([
    [], ['en-US'], ['zh'], ['cmn'], ['cmn-Hans-CN'],
    ['cmn-Hant-TW', 'cmn-Hans-CN'], ['cmn-Hans-CN', 'cmn-Hant-TW'],
    ['zh-Hant', 'zh-CN'], ['zh-TW', 'zh-SG'], ['zh-Hant', 'yue-Hans'],
    ['zh-Hans-TW'], ['zh-Latn-TW'], ['ja-Hant'], ['en-TW'], ['zh-x-hant'],
    ['zh-Hant', 'ZH-hANS'],
  ])('leaves scripts unchanged for %j', (...languageCodes) => {
    expect(prefersTraditionalChinese(languageCodes)).toBe(false);
  });
});

describe('character-only conversion', () => {
  it('converts mixed scripts without translating regional vocabulary', () => {
    expect(toTraditionalCharacters('这个软件通过网络播放视频，支援 OpenAI 與 Gemini。'))
      .toBe('這個軟件通過網絡播放視頻，支援 OpenAI 與 Gemini。');
  });

  it('uses the same default for ambiguous characters regardless of surrounding words', () => {
    expect(toTraditionalCharacters('头发、发展')).toBe('頭發、發展');
    expect(toTraditionalCharacters('头') + toTraditionalCharacters('发'))
      .toBe(toTraditionalCharacters('头发'));
  });

  it('preserves unmapped text, punctuation, whitespace, and Unicode sequences', () => {
    const text = '繁體中文 ABC café e\u0301 한글 かな 👩🏽‍💻 𠀀\n\t123！';
    expect(toTraditionalCharacters(text)).toBe(text);
    expect(toTraditionalCharacters('')).toBe('');
    expect(toTraditionalCharacters('𠮶')).toBe('嗰');
  });

  it('keeps the pinned dictionary restricted to one Unicode code point per side', () => {
    const entries = dictionary.split('|').map((entry) => entry.split(' '));
    expect(entries.length).toBeGreaterThan(3_000);
    expect(entries.every((entry) => entry.length === 2 && entry.every((part) => [...part].length === 1)))
      .toBe(true);
    const converted = entries.map(([source]) => toTraditionalCharacters(source!)).join('');
    expect(converted).toBe(entries.map(([, target]) => target).join(''));
  });

  it('applies each mapping once, even when its output is another dictionary key', () => {
    expect(toTraditionalCharacters('苎')).toBe('苧');
  });
});
