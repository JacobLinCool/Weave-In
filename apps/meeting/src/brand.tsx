import type { CSSProperties, ReactNode } from 'react';

/** Dyed-thread colours: one per seat, portable across the landing, the room, and the icon. */
export const THREAD_COLORS: readonly { name: string; hex: string; rgb: string }[] = Object.freeze([
  { name: 'peach', hex: '#F4A27E', rgb: '244,162,126' },
  { name: 'madder', hex: '#E0563F', rgb: '224,86,63' },
  { name: 'weld', hex: '#E9B44C', rgb: '233,180,76' },
  { name: 'verdigris', hex: '#5FC7A2', rgb: '95,199,162' },
  { name: 'woad', hex: '#7FB3E6', rgb: '127,179,230' },
  { name: 'lilac', hex: '#B79BE8', rgb: '183,155,232' },
  { name: 'moss', hex: '#9BBF5A', rgb: '155,191,90' },
  { name: 'rose', hex: '#E98BB4', rgb: '233,139,180' },
]);

export function threadColor(index: number): { hex: string; rgb: string } {
  const entry = THREAD_COLORS[((index % THREAD_COLORS.length) + THREAD_COLORS.length) % THREAD_COLORS.length];
  return entry ?? { hex: '#F4A27E', rgb: '244,162,126' };
}

export function threadStyle(index: number): CSSProperties {
  const color = threadColor(index);
  return { '--thread': color.hex, '--thread-rgb': color.rgb } as CSSProperties;
}

/** The woven mark: four dyed warps under undyed weft passes, warp rising on alternate crossings. */
export function WeaveMark({ size = 28, title = 'Weave In' }: { size?: number; title?: string }): ReactNode {
  const warps = ['#E0563F', '#E9B44C', '#5FC7A2', '#F4A27E'];
  return (
    <svg className="weave-mark" viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={title}>
      <rect width="64" height="64" rx="14" fill="#141A33" />
      {warps.map((color, i) => <rect key={`w${i}`} x={12 + i * 10} y="10" width="8" height="44" rx="2" fill={color} />)}
      {[0, 1, 2, 3].map((j) => <rect key={`f${j}`} x="10" y={12 + j * 10} width="44" height="8" rx="2" fill="#F3EEE3" />)}
      {[0, 1, 2, 3].flatMap((j) => warps.map((color, i) => (i + j) % 2 === 0
        ? <rect key={`x${i}${j}`} x={12 + i * 10} y={12 + j * 10} width="8" height="8" fill={color} />
        : null))}
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`}>
      <WeaveMark size={compact ? 24 : 30} />
      <span className="brand__word">Weave In</span>
    </div>
  );
}
