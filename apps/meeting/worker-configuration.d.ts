import type { MeetingRoom } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<MeetingRoom>;
      ASSETS: Fetcher;
      GEMINI_API_KEY?: string;
      OPENAI_API_KEY?: string;
      TRANSCRIPTION_PROVIDER?: string;
      TOKEN_RATE_LIMITER: RateLimit;
      ANALYSIS_RATE_LIMITER: RateLimit;
    }
  }
}

export {};
