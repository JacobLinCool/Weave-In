const REQUEST_TIMEOUT_MS = 10000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_REFRESH_ATTEMPTS = 3;

export interface IceConfiguration {
  iceServers: RTCIceServer[];
  expiresAt: number;
}

export class IceConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'IceConfigurationError';
  }
}

function provisioningError(code: unknown): IceConfigurationError {
  if (code === 'ICE_SERVICE_UNAVAILABLE') {
    return new IceConfigurationError(code, 'Meeting relay access is not configured. Please contact the meeting administrator.');
  }
  if (code === 'RATE_LIMITED') {
    return new IceConfigurationError(code, 'Meeting relay access is temporarily busy. Please wait a moment and try again.');
  }
  if (code === 'INVALID_ICE_RESPONSE') {
    return new IceConfigurationError(code, 'The meeting relay service returned invalid settings. Please try joining again.');
  }
  return new IceConfigurationError('ICE_PROVISIONING_FAILED', 'Could not obtain meeting relay access. Please try joining again.');
}

function parseConfiguration(value: unknown): IceConfiguration {
  const invalid = () => provisioningError('INVALID_ICE_RESPONSE');
  if (!value || typeof value !== 'object') throw invalid();
  const data = value as Record<string, unknown>;
  if (data.ok !== true) throw provisioningError(data.code);
  if (typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now()) throw invalid();
  if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) throw invalid();
  let hasRelay = false;
  const iceServers = data.iceServers.map((entry: unknown): RTCIceServer => {
    if (!entry || typeof entry !== 'object') throw invalid();
    const server = entry as Record<string, unknown>;
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== 'string' || !/^(?:stun|stuns|turn|turns):[^\s]+$/.test(url))) throw invalid();
    const relay = urls.some((url: string) => /^turns?:/.test(url));
    if (relay && (typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential)) throw invalid();
    hasRelay ||= relay;
    return relay ? { urls, username: server.username as string, credential: server.credential as string } : { urls };
  });
  if (!hasRelay) throw invalid();
  return { iceServers, expiresAt: data.expiresAt };
}

/** Owns one meeting's short-lived relay credentials, including refresh and cancellation. */
export class MeetingIceConfiguration {
  #configuration: IceConfiguration | null = null;
  #request: Promise<IceConfiguration> | null = null;
  #abort: AbortController | null = null;
  #requestTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #refreshAttempts = 0;

  constructor(
    private readonly onUpdate: (configuration: IceConfiguration) => void,
    private readonly onError: (error: IceConfigurationError) => void,
  ) {}

  get(): Promise<IceConfiguration> {
    if (this.#closed) return Promise.reject(new Error('Meeting closed.'));
    // Recheck the wall clock on every use: background tabs can miss their refresh timer.
    if (this.#configuration && this.#configuration.expiresAt > Date.now()) return Promise.resolve(this.#configuration);
    return this.#load();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#refreshTimer);
    clearTimeout(this.#requestTimer);
    this.#abort?.abort();
    this.#configuration = null;
  }

  #load(): Promise<IceConfiguration> {
    if (this.#request) return this.#request;
    const abort = new AbortController();
    this.#abort = abort;
    this.#requestTimer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    this.#request = (async () => {
      try {
        const response = await fetch('/api/ice-servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: abort.signal,
        });
        const data: unknown = await response.json();
        if (this.#closed) throw new Error('Meeting closed.');
        if (!response.ok) throw provisioningError(data && typeof data === 'object' ? (data as Record<string, unknown>).code : undefined);
        const configuration = parseConfiguration(data);
        this.#configuration = configuration;
        this.#refreshAttempts = 0;
        this.onUpdate(configuration);
        const remaining = configuration.expiresAt - Date.now();
        this.#scheduleRefresh(Math.max(1, remaining - Math.min(REFRESH_MARGIN_MS, remaining / 10)));
        return configuration;
      } catch (error) {
        if (this.#closed) throw new Error('Meeting closed.');
        if (error instanceof IceConfigurationError) throw error;
        throw provisioningError(undefined);
      }
    })().finally(() => {
      clearTimeout(this.#requestTimer);
      this.#requestTimer = undefined;
      this.#abort = null;
      this.#request = null;
    });
    return this.#request;
  }

  #scheduleRefresh(delay: number): void {
    clearTimeout(this.#refreshTimer);
    if (this.#closed) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#refresh();
    }, Math.min(delay, 2147483647));
  }

  async #refresh(): Promise<void> {
    try {
      await this.#load();
    } catch (error) {
      if (this.#closed) return;
      this.#refreshAttempts += 1;
      const remaining = (this.#configuration?.expiresAt ?? 0) - Date.now();
      if (this.#refreshAttempts < MAX_REFRESH_ATTEMPTS && remaining > 0) {
        const delay = 1000 * 2 ** (this.#refreshAttempts - 1) * (0.8 + Math.random() * 0.4);
        this.#scheduleRefresh(Math.min(delay, remaining));
      } else {
        this.onError(error instanceof IceConfigurationError ? error : provisioningError(undefined));
        // One final attempt at expiry can recover an outage without requiring a healthy peer to fail first.
        if (remaining > 0) this.#scheduleRefresh(remaining);
      }
    }
  }
}
