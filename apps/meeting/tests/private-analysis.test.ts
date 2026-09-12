import { describe, expect, it, vi } from 'vitest';
import {
  analyze,
  cosine,
  parseAnalysisInput,
  privateAnalysis,
  relatedRecords,
  validateDecision,
  type AnalysisInput,
} from '../worker/private-analysis';
import type { Env } from '../worker';
const input: AnalysisInput = {
  you: 'alice',
  records: [
    { seq: 1, at: 1, peerId: 'alice', name: 'Alice', text: 'Will data be lost on disconnect?' },
    { seq: 2, at: 2, peerId: 'bob', name: 'Bob', text: 'Let us approve the Friday launch.' },
  ],
  history: [],
};
const decision = {
  notify: true,
  concernSeq: 1,
  decisionSeq: 2,
  text: 'Before approving launch, can we verify recovery?',
};
const env = {
  GEMINI_API_KEY: 'test',
  ANALYSIS_RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Env;
function request(body: unknown = input, origin = 'https://meeting.test') {
  return new Request('https://meeting.test/api/private-analysis', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('private analysis boundaries', () => {
  it('orders replayed records by speech time before evaluating decisions', () => {
    const parsed = parseAnalysisInput({ ...input, records: [input.records[1], input.records[0]] });
    expect(parsed.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(validateDecision(decision, parsed)).not.toBeNull();
  });

  it('routes only to the original objection author and requires a later, recent decision', () => {
    expect(validateDecision(decision, input)?.evidenceSeqs).toEqual([1, 2]);
    expect(validateDecision(decision, { ...input, you: 'bob' })).toBeNull();
    expect(validateDecision({ ...decision, decisionSeq: 1 }, input)).toBeNull();
    expect(validateDecision({ ...decision, concernSeq: 99 }, input)).toBeNull();
    expect(validateDecision({ ...decision, notify: false }, input)).toBeNull();
    expect(validateDecision({ ...decision, text: 'x'.repeat(241) }, input)).toBeNull();
    expect(
      validateDecision(decision, {
        ...input,
        records: [...input.records, ...Array.from({ length: 4 }, (_, i) => ({ ...input.records[1]!, seq: i + 3 }))],
      }),
    ).toBeNull();
  });
  it('rejects malformed, oversized and duplicate records', () => {
    expect(() => parseAnalysisInput({ ...input, records: [input.records[0], input.records[0]] })).toThrow();
    expect(() =>
      parseAnalysisInput({ ...input, records: [{ ...input.records[0], text: 'x'.repeat(2001) }, input.records[1]] }),
    ).toThrow();
    expect(() => parseAnalysisInput({ ...input, history: ['x'.repeat(241)] })).toThrow();
  });
  it('retrieves older related speech with adjacent replies and preserves the latest context', () => {
    const records = Array.from({ length: 40 }, (_, i) => ({ ...input.records[0]!, seq: i + 1 }));
    const vectors = records.map((_, i) => (i === 3 || i >= 36 ? [1, 0] : [0, 1]));
    const selected = relatedRecords(records, vectors).map((r) => r.seq);
    expect(selected).toContain(4);
    expect(selected).toContain(5);
    expect(selected).toEqual(expect.arrayContaining(records.slice(-16).map((r) => r.seq)));
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
  it('uses embeddings then structured analysis and keeps the key on upstream requests only', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ embeddings: input.records.map(() => ({ values: Array(256).fill(0.1) })) }))
      .mockResolvedValueOnce(
        Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }] }),
      );
    expect(await analyze(input, 'secret', upstream)).toEqual({
      id: 'auto-1',
      text: decision.text,
      evidenceSeqs: [1, 2],
    });
    expect(String(upstream.mock.calls[0]?.[0])).toContain('batchEmbedContents');
    const generation = JSON.parse(String(upstream.mock.calls[1]?.[1]?.body));
    expect(JSON.parse(generation.contents[0].parts[0].text).records).toHaveLength(2);
  });
  it('rejects cross-origin, oversized and throttled requests before calling the model', async () => {
    const upstream = vi.fn<typeof fetch>();
    expect((await privateAnalysis(request(input, 'https://evil.test'), env, upstream)).status).toBe(403);
    expect((await privateAnalysis(request({ padding: 'x'.repeat(65537) }), env, upstream)).status).toBe(413);
    expect(
      (
        await privateAnalysis(
          request(),
          { ...env, ANALYSIS_RATE_LIMITER: { limit: async () => ({ success: false }) } as RateLimit },
          upstream,
        )
      ).status,
    ).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('reports provider failure without returning transcript or secrets', async () => {
    const response = await privateAnalysis(
      request(),
      env,
      vi.fn<typeof fetch>(async () => new Response('secret', { status: 500 })),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'ANALYSIS_UNAVAILABLE' });
  });
});
