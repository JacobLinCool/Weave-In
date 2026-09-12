async (page, origin = 'http://127.0.0.1:8788') => {
  const browser = page.context().browser();
  const setup = async (context) => {
    context.setDefaultTimeout(20_000);
    await context.grantPermissions(['microphone', 'camera']);
    await context.addInitScript(() => {
      if (location.origin === 'null') return;
      localStorage.setItem('weave-in:settings', JSON.stringify({ captionsEnabled: false, languageCodes: [], mode: 'VERBATIM' }));
      const state = window.__chatToolsTest = { states: [], sends: [], sessions: [], calls: [], results: [], images: [], errors: [], tools: {}, complete: false };
      Object.defineProperty(navigator, 'modelContext', { configurable: true, value: {
        registerTool(tool) { state.tools[tool.name] = tool; },
        unregisterTool(name) { delete state.tools[name]; },
      } });
      // Preserve actual room WebRTC, with silent microphones to avoid owner interruptions.
      const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const original = await getMedia(constraints);
        if (!constraints.audio) return original;
        const ac = new AudioContext(); await ac.resume();
        const osc = ac.createOscillator(); const gain = ac.createGain(); gain.gain.value = 0;
        const dest = ac.createMediaStreamDestination(); osc.connect(gain); gain.connect(dest); osc.start();
        for (const track of original.getAudioTracks()) { original.removeTrack(track); track.stop(); }
        original.addTrack(dest.stream.getAudioTracks()[0]);
        return original;
      };
      const OriginalSocket = window.WebSocket;
      window.WebSocket = class extends OriginalSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            try {
              const event = JSON.parse(data);
              if (event.type === 'agent-state') state.states.push(event.state);
              if (event.type === 'welcome') state.you = event.self.peerId;
            } catch { /* Other signaling messages need no inspection. */ }
          });
        }
      };
      const originalSend = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function(data) {
        if (typeof data === 'string') {
          try { state.sends.push({ channel: this.label, value: JSON.parse(data) }); } catch { /* File bytes are not JSON. */ }
        }
        return originalSend.call(this, data);
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (!String(input).match(/\/agents\/[^/]+\/live$/)) return originalFetch(input, init);
        const body = JSON.parse(init.body); state.sessions.push(body);
        const pc = new RTCPeerConnection();
        const ac = new AudioContext(); await ac.resume();
        const osc = ac.createOscillator(); const gain = ac.createGain(); gain.gain.value = 0;
        const dest = ac.createMediaStreamDestination(); osc.connect(gain); gain.connect(dest); osc.start();
        pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
        pc.ondatachannel = ({ channel: dc }) => {
          const emit = (event) => { if (dc.readyState === 'open') dc.send(JSON.stringify(event)); };
          let started = false; let step = 0; let fileInventory = [];
          const resultText = (result) => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          const fileId = (name) => {
            const file = fileInventory.find(entry => entry.name === name);
            if (!file) throw new Error(`Meeting tool omitted ${name}`);
            return file.id;
          };
          const steps = [
            () => ['read_meeting', { limit: 5 }],
            () => ['search_meeting', { query: 'release-workflow', limit: 5 }],
            () => ['read_shared_file', { fileId: fileId('workflow-notes.txt') }],
            () => ['read_shared_file', { fileId: fileId('workflow-reference.png') }],
            () => ['edit_whiteboard', { action: 'read', limit: 5 }],
            () => ['edit_whiteboard', { action: 'mermaid', source: 'flowchart LR\n A[Review intake] --> B{Approve?}\n B -->|Yes| C[Ship release]\n B -->|No| A' }],
            () => ['capture_whiteboard', { maxWidth: 640, format: 'jpeg', quality: 0.6 }],
            () => ['send_chat_message', { text: 'Workflow drawn: review intake, approve, then ship release.' }],
          ];
          const next = () => {
            try {
              if (step > 0) {
                const previous = state.results.find(result => result.callId === `tool_${step}`);
                if (!previous || previous.result.isError) throw new Error(`Tool ${step} failed: ${JSON.stringify(previous)}`);
                if (step === 1) fileInventory = JSON.parse(resultText(previous.result)).files;
                if (step === 2 && !resultText(previous.result).includes('release-workflow')) throw new Error('Meeting search did not return the guest context');
                if (step === 3 && !resultText(previous.result).includes('Review intake')) throw new Error('Shared text contents were not read');
              }
              if (step === steps.length) {
                emit({ type: 'response.event', delegation_id: 'answer', event: { type: 'response.created', response: { id: 'answer' } } });
                emit({ type: 'response.event', delegation_id: 'answer', event: { type: 'response.output_text.delta', delta: 'Done privately. private-reply-only' } });
                emit({ type: 'response.event', delegation_id: 'answer', event: { type: 'response.completed', response: { output: [] } } });
                emit({ type: 'session.output_transcript.delta', delta: 'Done privately. private-reply-only', start_ms: 0, end_ms: 1000 });
                state.complete = true;
                return;
              }
              const [name, args] = steps[step]();
              const callId = `tool_${++step}`;
              state.calls.push({ name, args, callId });
              emit({ type: 'response.event', delegation_id: callId, event: { type: 'response.created', response: { id: callId } } });
              emit({ type: 'response.event', delegation_id: callId, event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } } });
              emit({ type: 'response.event', delegation_id: callId, event: { type: 'response.completed', response: { output: [] } } });
            } catch (error) { state.errors.push(String(error)); }
          };
          dc.onopen = () => emit({ type: 'session.started', session: { id: 'live_tools_mock' } });
          dc.onmessage = ({ data }) => {
            const event = JSON.parse(data);
            if (event.type === 'response.item.create') {
              if (event.item?.type === 'function_call_output') {
                state.results.push({ callId: event.item.call_id, result: JSON.parse(event.item.output) });
              }
              for (const part of event.item?.content ?? []) {
                if (part.type === 'input_image') state.images.push({ call: step, imageUrl: part.image_url });
              }
              const text = event.item?.content?.[0]?.text;
              if (!started && typeof text === 'string' && text.startsWith('Background context only')) {
                started = true;
                setTimeout(() => {
                  emit({ type: 'session.input_transcript.delta', delta: 'private-voice-only: Read the uploaded reference, draw the release workflow on the whiteboard, and post its steps in Room chat.', start_ms: 0, end_ms: 1000 });
                  next();
                }, 300);
              }
            }
            if (event.type === 'response.create' && started && !state.complete && !state.errors.length) next();
            if (event.type === 'session.close') {
              emit({ type: 'session.closed', usage: { seconds: 1 }, reason: 'close_requested' });
              setTimeout(() => { pc.close(); osc.stop(); void ac.close(); }, 50);
            }
          };
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        if (pc.iceGatheringState !== 'complete') await new Promise(resolve => {
          pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
        });
        return new Response(JSON.stringify({ session: { id: 'live_tools_mock' }, transport: { type: 'webrtc', sdp: pc.localDescription.sdp } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      };
    });
  };
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const tab = (p, name) => p.getByRole('tab', { name: new RegExp(`^${name}`) });
  const personalReady = (p) => p.waitForFunction(() => window.__chatToolsTest.states.at(-1)?.agents.some(agent => agent.config.kind === 'personal' && agent.owner === window.__chatToolsTest.you));
  try {
    await setup(ownerContext); await setup(guestContext);
    page = await ownerContext.newPage(); const guest = await guestContext.newPage();
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alice');
    await page.getByRole('button', { name: 'Create a room', exact: true }).click();
    await personalReady(page);
    await guest.goto(page.url());
    await guest.getByRole('textbox', { name: 'Display name', exact: true }).fill('Bob');
    await guest.getByRole('button', { name: 'Join', exact: true }).click();
    await personalReady(guest);
    for (const p of [page, guest]) {
      if (await p.evaluate(() => window.__chatToolsTest.sessions.length)) throw new Error('GPT-Live started without an owner request');
      await tab(p, 'Room').click();
    }
    await guest.getByPlaceholder('Send a message').fill('release-workflow: Review intake, decide whether to approve, then ship the release.');
    await guest.getByPlaceholder('Send a message').press('Enter');
    await page.getByTestId('chat-list').getByText(/release-workflow/).waitFor();
    const image = await guest.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 480, 180);
      ctx.strokeStyle = '#171c35'; ctx.lineWidth = 3; ctx.strokeRect(20, 50, 160, 70); ctx.strokeRect(300, 50, 160, 70);
      ctx.beginPath(); ctx.moveTo(180, 85); ctx.lineTo(300, 85); ctx.stroke();
      ctx.fillStyle = '#171c35'; ctx.font = '22px sans-serif'; ctx.fillText('Review intake', 28, 92); ctx.fillText('Ship release', 312, 92);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await guest.getByTestId('file-picker').setInputFiles([
      { name: 'workflow-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Review intake, approve the plan, and ship release. If rejected, return to intake.\n') },
      { name: 'workflow-reference.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') },
    ]);
    await page.getByTestId('file-card').getByText('workflow-notes.txt', { exact: true }).waitFor();
    await page.getByTestId('file-card').getByText('workflow-reference.png', { exact: true }).waitFor();
    if (await page.getByRole('region', { name: 'Shared whiteboard', exact: true }).count()) throw new Error('Whiteboard should start closed');
    await tab(page, 'Chat').click();
    await page.getByRole('button', { name: 'Talk to Chat', exact: true }).click();
    await page.waitForFunction(() => window.__chatToolsTest.complete || window.__chatToolsTest.errors.length, null, { timeout: 60_000 });
    const errors = await page.evaluate(() => window.__chatToolsTest.errors);
    if (errors.length) throw new Error(errors.join('\n'));
    await page.getByRole('log', { name: 'Personal assistant transcript' }).getByText(/private-reply-only/).waitFor();
    await page.getByRole('region', { name: 'Shared whiteboard', exact: true }).waitFor();
    const zoom = await page.evaluate(() => {
      const value = Array.from(document.querySelectorAll('.whiteboard button')).map(button => button.textContent?.trim()).find(text => /^\d+(?:\.\d+)?%$/.test(text ?? ''));
      return value ? Number.parseFloat(value) : null;
    });
    if (zoom === null || zoom <= 0 || zoom > 200) throw new Error(`Whiteboard zoom does not frame the diagram: ${zoom}%`);
    if (await page.getByRole('button', { name: 'Scroll back to content', exact: true }).isVisible()) throw new Error('Whiteboard content is outside the viewport');
    const renderedDiagram = await page.evaluate(async () => {
      const image = window.__chatToolsTest.images.find(entry => entry.call === 7);
      if (!image) throw new Error('No rendered whiteboard image reached GPT-Live');
      const [header, data] = image.imageUrl.split(',');
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: header.slice(5).split(';')[0] }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0; let left = canvas.width; let top = canvas.height; let right = -1; let bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4;
        // Default board is white: dark foreground pixels must include real diagram strokes/text.
        if (pixels[index + 3] > 200 && Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 180) {
          count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      return { width: canvas.width, height: canvas.height, count, left, top, right, bottom };
    });
    if (renderedDiagram.count < 100 || renderedDiagram.right - renderedDiagram.left < renderedDiagram.width * 0.15 || renderedDiagram.bottom - renderedDiagram.top < renderedDiagram.height * 0.1) throw new Error(`Whiteboard capture does not contain a visible diagram: ${JSON.stringify(renderedDiagram)}`);
    if (renderedDiagram.left < 1 || renderedDiagram.top < 1 || renderedDiagram.right >= renderedDiagram.width - 1 || renderedDiagram.bottom >= renderedDiagram.height - 1) throw new Error(`Whiteboard diagram is clipped at the capture edge: ${JSON.stringify(renderedDiagram)}`);
    await guest.getByTestId('chat-list').getByText('Workflow drawn: review intake, approve, then ship release.', { exact: true }).waitFor();
    const post = guest.getByTestId('chat-list').locator('li').filter({ hasText: 'Workflow drawn: review intake, approve, then ship release.' });
    if (!(await post.innerText()).includes("Alice's agent")) throw new Error('Room post lost owner attribution');
    await guest.waitForFunction(async () => {
      const result = await window.__chatToolsTest.tools.edit_whiteboard.execute({ action: 'read', limit: 100 });
      return JSON.stringify(result).includes('Ship release') && JSON.stringify(result).includes('Review intake');
    });
    const provider = await page.evaluate(() => {
      const state = window.__chatToolsTest;
      return { names: state.sessions[0].session.delegation.responses.tools.map(tool => tool.name), calls: state.calls.map(call => call.name), imageCalls: state.images.map(image => image.call), imagesValid: state.images.every(image => /^data:image\/(jpeg|png);base64,/.test(image.imageUrl)), configs: state.states.at(-1).agents.filter(agent => agent.owner === state.you).map(agent => agent.config), peerLeak: state.sends.some(item => item.channel === 'weave-in' && /private-voice-only|private-reply-only/.test(JSON.stringify(item.value))) };
    });
    for (const required of ['read_meeting', 'search_meeting', 'read_shared_file', 'edit_whiteboard', 'capture_whiteboard', 'send_chat_message']) {
      if (!provider.names.includes(required)) throw new Error(`GPT-Live was not initialized with ${required}`);
    }
    if (provider.names.includes('capture_screen_share')) throw new Error('Shared screen capture was enabled without opt-in');
    if (!provider.configs.some(config => config.kind === 'personal' && config.files && config.source === 'all' && config.chat && !config.screen)) throw new Error('Personal default context permissions are incorrect');
    if (!provider.imagesValid || !provider.imageCalls.includes(4) || !provider.imageCalls.includes(7)) throw new Error('File or whiteboard image was not forwarded as provider input_image');
    if (provider.peerLeak) throw new Error('Private voice conversation was sent to the guest');
    await tab(guest, 'Transcript').click();
    if (/private-voice-only|private-reply-only/.test(await guest.locator('body').innerText())) throw new Error('Guest saw private voice conversation');
    await page.getByRole('button', { name: 'Finish speaking', exact: true }).click();
    await page.getByRole('button', { name: 'Talk to Chat', exact: true }).waitFor();
    return { clients: 2, calls: provider.calls, guestFileTransfer: true, sharedImageAsProviderVision: true, guestBoardSync: true, boardAutoOpen: true, renderedBoardAsProviderVision: true, diagramInViewport: true, boardZoom: zoom, renderedDiagram, attributedRoomPost: true, privateVoiceIsolation: true, allParticipantContextDefault: true, screenOptInPreserved: true, provider: 'simulated GPT-Live WebRTC with real room and tool execution (no real provider call)' };
  } finally {
    await Promise.all([ownerContext, guestContext].map(context => context.close()));
  }
}
