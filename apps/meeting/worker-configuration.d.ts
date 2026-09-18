import type { MeetingRoom } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<MeetingRoom>;
      ASSETS: Fetcher;
      GEMINI_API_KEY?: string;
      OPENAI_API_KEY?: string;
      TYPESAFE_API_KEY?: string;
      TRANSCRIPTION_PROVIDER?: string;
      TOKEN_RATE_LIMITER: RateLimit;
      ANALYSIS_RATE_LIMITER: RateLimit;
      TURN_KEY_ID?: string;
      TURN_KEY_SECRET?: string;
      ICE_RATE_LIMITER: RateLimit;
    }
  }
}

export {};
