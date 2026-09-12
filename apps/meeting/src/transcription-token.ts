import type { TranscriptionProvider } from '@weave-in/transcribe';

export interface IssuedToken { provider: TranscriptionProvider; token: string }

export async function requestTranscriptionToken(signal?: AbortSignal): Promise<IssuedToken> {
  const response = await fetch('/api/transcription-token', {
    ...(signal ? { signal } : {}),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (response.status === 503) {
    throw new Error('Speech transcription is unavailable: no provider is configured.');
  }
  if (!response.ok) throw new Error('The meeting could not obtain a temporary transcription token.');
  const payload: unknown = await response.json();
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const provider = record?.['provider'];
  const token = typeof record?.['token'] === 'string' ? record['token'].trim() : '';
  if ((provider !== 'gemini' && provider !== 'openai') || !token) {
    throw new Error('The meeting received an invalid token response.');
  }
  return { provider, token };
}

