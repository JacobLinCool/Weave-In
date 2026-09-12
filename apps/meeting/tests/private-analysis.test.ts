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
  it('allows a dismissed concern to recur only for a linked substantive later development', () => {
    const history = [
      {
        text: decision.text,
        concernSeq: 1,
        decisionSeq: 2,
        concernText: input.records[0]!.text,
        decisionText: input.records[1]!.text,
      },
    ];
    const next = { ...input.records[1]!, seq: 3, at: 3, text: 'The deployment has started; traffic is moving now.' };
    const recurring = { ...input, records: [...input.records, next], history };
    const proposal = { ...decision, decisionSeq: 3, previousDecisionSeq: 2, developmentType: 'execution_started' };
    expect(validateDecision(proposal, recurring)?.id).toBe('auto-1-3');
    expect(validateDecision({ ...proposal, previousDecisionSeq: 0 }, recurring)).toBeNull();
    expect(validateDecision({ ...proposal, developmentType: 'none' }, recurring)).toBeNull();
    expect(validateDecision({ ...proposal, previousDecisionSeq: 99 }, recurring)).toBeNull();
    expect(validateDecision({ ...proposal, decisionSeq: 2 }, recurring)).toBeNull();
    expect(
      validateDecision(proposal, {
        ...recurring,
        records: [...input.records, { ...next, text: 'LET US APPROVE THE FRIDAY LAUNCH!' }],
      }),
    ).toBeNull();
    const latest = { ...history[0]!, decisionSeq: 3, decisionText: next.text };
    const fourth = { ...next, seq: 4, at: 4, text: 'Expand rollout to all customers.' };
    expect(
      validateDecision(
        { ...proposal, decisionSeq: 4 },
        {
          ...recurring,
          records: [...recurring.records, fourth],
          history: [latest, ...history],
        },
      ),
    ).toBeNull();
    expect(
      validateDecision(
        { ...proposal, decisionSeq: 4, previousDecisionSeq: 3, developmentType: 'changed_scope' },
        {
          ...recurring,
          records: [...recurring.records, fourth],
          history: [latest, ...history],
        },
      )?.id,
    ).toBe('auto-1-4');
  });
  it('does not evade recurrence checks by restating the same concern under a new seq', () => {
    const history = [
      {
        text: decision.text,
        concernSeq: 1,
        decisionSeq: 2,
        concernText: input.records[0]!.text,
        decisionText: input.records[1]!.text,
      },
    ];
    const records = [
      { ...input.records[0]!, seq: 3, at: 3 },
      { ...input.records[1]!, seq: 4, at: 4 },
    ];
    expect(validateDecision({ ...decision, concernSeq: 3, decisionSeq: 4 }, { ...input, records, history })).toBeNull();
    const paraphrase = { ...records[0]!, text: 'Have we checked disconnect recovery?' };
    const linked = { ...decision, concernSeq: 3, decisionSeq: 4, previousDecisionSeq: 2, developmentType: 'none' };
    expect(validateDecision(linked, { ...input, records: [paraphrase, records[1]!], history })).toBeNull();
  });
  it('accepts bounded structured and legacy history and rejects malformed event evidence', () => {
    const history = {
      text: decision.text,
      concernSeq: 1,
      decisionSeq: 2,
      concernText: input.records[0]!.text,
      decisionText: input.records[1]!.text,
    };
    expect(parseAnalysisInput({ ...input, history: [history, 'legacy reminder'] }).history).toEqual([
      history,
      'legacy reminder',
    ]);
    for (const invalid of [
      null,
      [],
      { ...history, concernSeq: 0 },
      { ...history, decisionSeq: 1 },
      { ...history, decisionText: '' },
      { ...history, concernText: 'x'.repeat(2001) },
    ]) {
      expect(() => parseAnalysisInput({ ...input, history: [invalid] })).toThrow();
    }
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
      id: 'auto-1-2',
      text: decision.text,
      evidenceSeqs: [1, 2],
    });
    expect(String(upstream.mock.calls[0]?.[0])).toContain('batchEmbedContents');
    const generation = JSON.parse(String(upstream.mock.calls[1]?.[1]?.body));
    expect(JSON.parse(generation.contents[0].parts[0].text).records).toHaveLength(2);
    expect(JSON.parse(generation.contents[0].parts[0].text).you).toBe('alice');
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
