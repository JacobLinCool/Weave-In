import simplifiedToTraditional from 'opencc-js/dict/STCharacters';

const traditionalCharacters = new Map(
  simplifiedToTraditional.split('|').map((entry): [string, string] => {
    const separator = entry.indexOf(' ');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }),
);

export function prefersTraditionalChinese(languageCodes: readonly string[]): boolean {
  const scripts = languageCodes.map(chineseScript);
  return scripts.includes('hant') && !scripts.includes('hans');
}

export function toTraditionalCharacters(text: string): string {
  // Use only the character dictionary's first candidates, without phrase matching.
  return text.replace(/./gsu, (character) => traditionalCharacters.get(character) ?? character);
}

function chineseScript(languageCode: string): string | undefined {
  const parts = languageCode.toLowerCase().split('-');
  const language = parts.shift();
  if (language !== 'zh' && language !== 'cmn' && language !== 'yue') return undefined;
  if (language === 'zh' && (parts[0] === 'cmn' || parts[0] === 'yue')) parts.shift();

  // An explicit script wins over region, including non-Han scripts such as Latn.
  if (parts[0]?.length === 4) return parts[0];
  switch (parts[0]) {
    case 'tw':
    case 'hk':
    case 'mo':
      return 'hant';
    case 'cn':
    case 'sg':
      return 'hans';
    default:
      return undefined;
  }
}
