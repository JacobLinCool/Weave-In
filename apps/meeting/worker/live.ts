import { LIVE_MODEL, REASONING_MODEL, TOOL_NAMES, record, type RoomAgent } from '../src/agents/contracts';

export function validLiveRequest(value: unknown, agent: RoomAgent): value is { sdp: string; session: Record<string, unknown>; epoch: number; request: number } {
  if (!record(value) || typeof value.sdp !== 'string' || !value.sdp.startsWith('v=0') || value.sdp.length > 48_000) return false;
  if (value.epoch !== agent.epoch || value.request !== agent.request || !record(value.session)) return false;
  const session = value.session;
  if (Object.keys(session).some((key) => !['model', 'instructions', 'delegation'].includes(key))) return false;
  if (session.model !== LIVE_MODEL || typeof session.instructions !== 'string' || session.instructions.length > 12_000) return false;
  if (!record(session.delegation) || session.delegation.type !== 'responses' || Object.keys(session.delegation).some((key) => !['type', 'responses'].includes(key))) return false;
  const backend = session.delegation.responses;
  if (!record(backend) || backend.model !== REASONING_MODEL || typeof backend.instructions !== 'string' || backend.instructions.length > 12_000) return false;
  if (Object.keys(backend).some((key) => !['model', 'instructions', 'tools', 'parallel_tool_calls'].includes(key))) return false;
  if (backend.parallel_tool_calls !== false || !Array.isArray(backend.tools) || backend.tools.length > 4) return false;
  const names = new Set<string>();
  return backend.tools.every((tool: unknown) => {
    if (!record(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !TOOL_NAMES.includes(tool.name as typeof TOOL_NAMES[number]) || names.has(tool.name)) return false;
    if (Object.keys(tool).some((key) => !['type', 'name', 'description', 'parameters'].includes(key))) return false;
    if (typeof tool.description !== 'string' || tool.description.length > 2_000 || !record(tool.parameters)) return false;
    if (tool.name === 'capture_screen_share' && !agent.config.screen) return false;
    if (tool.name === 'download_file' && !agent.config.files) return false;
    if (tool.name === 'send_chat_message' && agent.config.kind === 'group' && agent.phase !== 'speaking') return false;
    names.add(tool.name);
    return true;
  });
}

export async function initializeLive(request: Request, agent: RoomAgent, key: string, upstream: typeof fetch = fetch): Promise<Response> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return Response.json({ error: 'JSON required.' }, { status: 415 });
  // Bound the stream before JSON parsing; Content-Length alone is not trustworthy.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: 'Missing request.' }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 65_536) { await reader.cancel(); return Response.json({ error: 'Request too large.' }, { status: 413 }); }
    chunks.push(part.value);
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))))); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!validLiveRequest(body, agent)) return Response.json({ error: 'Invalid or outdated agent session settings.' }, { status: 400 });
  try {
    const response = await upstream('https://api.openai.com/v1/live/sessions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: body.session, transport: { type: 'webrtc', sdp: body.sdp } }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return Response.json({ error: `GPT-Live initialization failed (${response.status}).` }, { status: 502 });
    const result: unknown = await response.json();
    if (!record(result) || !record(result.session) || typeof result.session.id !== 'string' || !record(result.transport) || typeof result.transport.sdp !== 'string') throw new Error('Invalid response');
    return Response.json({ session: { id: result.session.id }, transport: { type: 'webrtc', sdp: result.transport.sdp } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'GPT-Live could not connect. Try again.' }, { status: 502 }); }
}
