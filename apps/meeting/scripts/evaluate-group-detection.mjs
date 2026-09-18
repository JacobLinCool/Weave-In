import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const vars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const localKey = vars.split(/\r?\n/).find(line => /^TYPESAFE_API_KEY\s*=/.test(line))?.split('=').slice(1).join('=').trim().replace(/^(["'])(.*)\1$/, '$2');
const key = process.env.TYPESAFE_API_KEY?.trim() || localKey;
if (!key) throw new Error('Set TYPESAFE_API_KEY in the environment or apps/meeting/.dev.vars.');

const fixtures = [
  { name: 'premature closure', expected: 'convergence', lines: [
    ['Alice', 'We must choose a launch date today.'], ['Bob', 'We have not tested rollback; customer data could be lost.'],
    ['Alice', 'No need to test rollback. We are done considering alternatives.'], ['Bob', 'My data-loss objection is still unresolved.'], ['Alice', 'Approved. Ship tomorrow regardless of that objection.'],
  ] },
  { name: 'sustained drift', expected: 'drift', lines: [
    ['Alice', 'Our goal today is to choose PostgreSQL or MySQL for the order service.'], ['Bob', 'Both support the required transactions.'],
    ['Alice', 'I saw a beach resort advertisement.'], ['Bob', 'I prefer mountain holidays to beaches.'], ['Alice', 'Do you like skiing or hiking on holiday?'], ['Bob', 'I like skiing in Switzerland.'],
  ] },
  { name: 'uneven participation', expected: 'float', lines: [
    ['Alice', 'We need a rollout checklist. I suggest a staged release.'], ['Alice', 'First deploy to our internal staff.'],
    ['Alice', 'Then enable it for one percent of accounts.'], ['Alice', 'Measure errors for a day before expanding.'],
    ['Alice', 'Set a rollback threshold of one percent errors.'], ['Alice', 'I will keep listing the rollout steps; next is monitoring latency.'],
  ] },
  { name: 'agreement without reasons', expected: 'echo', lines: [
    ['Alice', 'One option is to use the new vendor. What do you think?'], ['Bob', 'Sounds good to me.'], ['Carol', 'I agree.'], ['Alice', 'Yes, sounds good.'], ['Bob', 'Same here.'],
  ] },
  { name: 'resolved objection', expected: null, lines: [
    ['Alice', 'Choose a launch date after reviewing rollback.'], ['Bob', 'Rollback is my only concern.'],
    ['Carol', 'The staging rollback test restored all records with matching checksums in two minutes. Here are the test results.'], ['Bob', 'That resolves my concern. I support tomorrow.'], ['Alice', 'We compared the dates and verified rollback. Tomorrow is approved.'],
  ] },
  { name: 'Traditional Chinese closure', expected: 'convergence', lines: [
    ['Alice', '今天要決定新版明天是否上線。'], ['Bob', '付款失敗時會重複扣款，還沒測試退款流程。'],
    ['Carol', '這個重複扣款的問題還沒有解決，應該先測試。'], ['Alice', '不用再討論替代方案，也不用測退款了，直接決定明天上線。'],
  ] },
];

const server = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { groupDetectionRequest, readGroupDetection } = await server.ssrLoadModule('/worker/group-review.ts');
  const participants = ['Alice', 'Bob', 'Carol'].map(name => ({ peerId: name, name }));
  for (const fixture of fixtures) {
    const context = { records: fixture.lines.map(([peerId, text], i) => ({ seq: i + 1, kind: 'chat', peerId, text, at: new Date(i * 1000).toISOString(), truncated: false })), previousInterventions: [] };
    const start = performance.now();
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(groupDetectionRequest(context, participants)), signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}.`);
    const result = await response.json();
    const detection = readGroupDetection(result);
    const outcome = (detection?.kind ?? null) === fixture.expected ? 'matched' : detection === null ? 'abstained' : 'incorrect';
    const classificationMatched = fixture.expected === null ? detection === null : result.answers[fixture.expected]?.choice === 'present';
    console.log(JSON.stringify({ fixture: fixture.name, model: result.model, expected: fixture.expected, detection, outcome, classificationMatched, milliseconds: Math.round(performance.now() - start), answers: result.answers }));
    if (!classificationMatched || outcome === 'incorrect') process.exitCode = 1;
  }
} finally { await server.close(); }
