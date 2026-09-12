import { describe, expect, it } from 'vitest';
import { formatMeetingDuration } from '../src/meeting-timer';

describe('meeting duration', () => {
  it.each([
    [0, '00:00'],
    [59.9, '00:59'],
    [60, '01:00'],
    [3_599, '59:59'],
    [3_600, '1:00:00'],
    [3_723, '1:02:03'],
    [90_061, '25:01:01'],
    [-1, '00:00'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatMeetingDuration(seconds)).toBe(expected);
  });
});
