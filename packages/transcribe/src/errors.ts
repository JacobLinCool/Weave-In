export class TranscribeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranscribeError';
    this.code = code;
  }
}

export function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof TranscribeError) return { code: error.code, message: error.message };
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : 'An unexpected transcription error occurred.',
  };
}
