import { describe, expect, it } from 'vitest';
import { calculateVoiceLevel } from '../src/voice-activity';

describe('voice activity level', () => {
  it('gates background noise and attacks quickly on speech', () => {
    const silence = new Uint8Array(256).fill(128);
    const backgroundNoise = alternatingSamples(126, 130);
    const speech = alternatingSamples(96, 160);

    expect(calculateVoiceLevel(silence, 0)).toBe(0);
    expect(calculateVoiceLevel(backgroundNoise, 0)).toBe(0);
    expect(calculateVoiceLevel(speech, 0)).toBeCloseTo(0.42, 5);
  });

  it('releases smoothly instead of flickering off between syllables', () => {
    const silence = new Uint8Array(256).fill(128);
    expect(calculateVoiceLevel(silence, 1)).toBeCloseTo(0.86, 5);
  });
});

function alternatingSamples(low: number, high: number): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, index) => index % 2 === 0 ? low : high);
}
