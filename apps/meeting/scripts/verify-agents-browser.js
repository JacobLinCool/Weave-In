async (page, origin = 'http://127.0.0.1:8788') => {
  const browser = page.context().browser();
  const setup = async (context) => {
    context.setDefaultTimeout(15_000);
    await context.grantPermissions(['microphone', 'camera']);
    await context.addInitScript(() => {
      localStorage.setItem('weave-in:settings', JSON.stringify({ captionsEnabled: false, languageCodes: [], mode: 'VERBATIM' }));
      window.__agentTest = { states: [], sends: [], sessions: [], incoming: [], peers: [], sockets: [], microphones: [], audible: 0, tools: {} };
      Object.defineProperty(navigator, 'modelContext', { configurable: true, value: {
        registerTool(tool) { window.__agentTest.tools[tool.name] = tool; },
        unregisterTool(name) { delete window.__agentTest.tools[name]; },
      } });
      // Deterministic silent human microphones keep provider audio from looking like owner interruption.
      const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const original = await getMedia(constraints);
        if (!constraints.audio) return original;
        const ac = new AudioContext(); await ac.resume();
        const oscillator = ac.createOscillator(); const gain = ac.createGain(); gain.gain.value = 0;
        const dest = ac.createMediaStreamDestination(); oscillator.connect(gain); gain.connect(dest); oscillator.start();
        for (const track of original.getAudioTracks()) { original.removeTrack(track); track.stop(); }
        original.addTrack(dest.stream.getAudioTracks()[0]);
        window.__agentTest.microphones.push({ ac, gain, oscillator });
        return original;
      };
      const originalConnect=AudioNode.prototype.connect;
      AudioNode.prototype.connect=function(destination,...args) {
        const result=originalConnect.call(this,destination,...args);
        if(destination===this.context.destination){
          const analyser=this.context.createAnalyser(); originalConnect.call(this,analyser);
          const samples=new Float32Array(256); analyser.fftSize=256;
          const timer=setInterval(()=>{ if(this.context.state==='closed'){clearInterval(timer);return;} analyser.getFloatTimeDomainData(samples); window.__agentTest.audible=Math.max(window.__agentTest.audible,...samples.map(Math.abs)); },30);
        }
        return result;
      };
      const OriginalSocket = window.WebSocket;
      window.WebSocket = class extends OriginalSocket {
        constructor(...args) { super(...args); window.__agentTest.sockets.push(this); this.addEventListener('message', (e) => { try { const v=JSON.parse(e.data); if(v.type==='agent-state') window.__agentTest.states.push(v.state); if(v.type==='welcome') window.__agentTest.you = v.self.peerId; } catch {} }); }
      };
      const originalSend = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function(data) { if(typeof data==='string') { try { const v=JSON.parse(data); window.__agentTest.sends.push({channel:this.label,value:v}); } catch {} } return originalSend.call(this,data); };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (!String(input).match(/\/agents\/[^/]+\/live$/)) return originalFetch(input, init);
        const body=JSON.parse(init.body); window.__agentTest.sessions.push(body);
        const pc=new RTCPeerConnection(); window.__agentTest.peers.push(pc); pc.onconnectionstatechange=()=>window.__agentTest.incoming.push(pc.connectionState); const ac=new AudioContext(); await ac.resume();
        const osc=ac.createOscillator(); const gain=ac.createGain(); gain.gain.value=0;
        const dest=ac.createMediaStreamDestination(); osc.connect(gain); gain.connect(dest); osc.start();
        pc.addTrack(dest.stream.getAudioTracks()[0],dest.stream);
        pc.ondatachannel=({channel:dc})=> { window.__agentTest.incoming.push('datachannel');
          const emit=(event)=>{ if(dc.readyState==='open') dc.send(JSON.stringify(event)); };
          let request=''; let responding=false;
          const answer=()=> {
            if(responding)return;responding=true;
            const preparing=body.session.instructions.includes('prepares a suggestion silently');
            const value=preparing?'Consider an alternative before deciding.':request.split('Current explicit request:').at(-1).includes('private-secret')?'Private response.':request.split('Current explicit request:').at(-1).includes('Speak once on behalf')?'Can we verify that the mute button remains usable?' :'A useful perspective for the meeting.';
            emit({type:'response.event',delegation_id:'d1',event:{type:'response.created',response:{id:'r1'}}});
            emit({type:'response.event',delegation_id:'d1',event:{type:'response.output_text.delta',delta:value}});
            if(preparing){ gain.gain.value=.1; emit({type:'session.output_transcript.delta',delta:'SUPPRESSED PREPARATION',start_ms:0,end_ms:800}); }
            emit({type:'response.event',delegation_id:'d1',event:{type:'response.completed',response:{output:[]}}});
            if(!preparing){setTimeout(()=>{ gain.gain.value=.12; emit({type:'session.output_transcript.delta',delta:value,start_ms:0,end_ms:1000}); },150);setTimeout(()=>gain.gain.value=0,1200);}
          };
          dc.onopen=()=>{window.__agentTest.incoming.push('open');emit({type:'session.started',session:{id:'live_mock'}});};
          dc.onmessage=({data})=>{
            const event=JSON.parse(data); window.__agentTest.incoming.push(event.type);
            if(event.type==='response.item.create'){request=event.item?.content?.[0]?.text??request;if(request.startsWith('Background context only'))setTimeout(()=>{emit({type:'session.input_transcript.delta',delta:'voice-secret',start_ms:0,end_ms:1000});answer();},500);}
            if(event.type==='response.create')answer();
            if(event.type==='session.close'){gain.gain.value=0;emit({type:'session.output_transcript.delta',delta:' late.',start_ms:1000,end_ms:1200});setTimeout(()=>{emit({type:'session.closed',usage:{seconds:1},reason:'close_requested'});setTimeout(()=>{pc.close();osc.stop();void ac.close();},100);},50);}
          };
        };
        await pc.setRemoteDescription({type:'offer',sdp:body.sdp});await pc.setLocalDescription(await pc.createAnswer());
        if(pc.iceGatheringState!=='complete')await new Promise(r=>{pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')r();};});
        return new Response(JSON.stringify({session:{id:'live_mock'},transport:{type:'webrtc',sdp:pc.localDescription.sdp}}),{status:201,headers:{'Content-Type':'application/json'}});
      };
    });
  };
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const personalReady = (p) => p.waitForFunction(() => window.__agentTest.states.at(-1)?.agents.some(a => a.config.kind === 'personal' && a.owner === window.__agentTest.you));
  const tab = (p, name) => p.getByRole('tab', { name: new RegExp(`^${name}`) });
  try {
    await setup(ownerContext); await setup(guestContext);
    page = await ownerContext.newPage(); const guest = await guestContext.newPage();
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alice');
    await page.getByRole('button', { name: 'Create a room', exact: true }).click();
    await tab(page, 'Muse').waitFor(); await personalReady(page);
    const roomUrl = page.url();
    await guest.goto(roomUrl);
    await guest.getByRole('textbox', { name: 'Display name', exact: true }).fill('Bob');
    await guest.getByRole('button', { name: 'Join', exact: true }).click(); await personalReady(guest);
    for (const p of [page, guest]) {
      if (await p.evaluate(() => window.__agentTest.sessions.length)) throw new Error('Live opened automatically on room entry');
    }
    await tab(guest, 'Muse').click();
    await guest.locator('.agent-panel--personal').getByRole('button', { name: 'Settings', exact: true }).click();
    await guest.getByRole('button', { name: 'Enable assistant audio', exact: true }).click();
    await guest.getByRole('button', { name: 'Close assistant settings', exact: true }).click();
    await tab(page, 'Muse').click();
    await page.getByRole('textbox', { name: 'Message Muse', exact: true }).fill('private-secret');
    await page.locator('.agent-personal').getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('log', { name: 'Personal assistant transcript' }).getByText(/Private response/).waitFor();
    await page.getByRole('log', { name: 'Personal assistant transcript' }).getByText(/late/).waitFor();
    if (await page.evaluate(() => window.__agentTest.sends.some(x => x.channel === 'weave-in' && /private-secret|Private response/.test(JSON.stringify(x.value))))) throw new Error('Private Muse leaked to peers');
    if (await guest.locator('body').innerText().then(t => /private-secret|Private response/.test(t))) throw new Error('Guest saw private Muse');

    // Seed a real public record, then exercise the reminder action rather than an internal runtime hook.
    await tab(page, 'Room').click();
    await page.getByPlaceholder('Send a message').fill('Test decision: verify mute works before release.');
    await page.getByPlaceholder('Send a message').press('Enter');
    await page.waitForFunction(() => !!window.__agentTest.tools.show_private_notice);
    await page.evaluate(async () => {
      const tools = window.__agentTest.tools;
      const result = await tools.read_meeting.execute({});
      const payload = JSON.parse(result.content.find(c => c.type === 'text').text);
      const entries = payload.entries ?? payload.records;
      const row = entries.find(entry => entry.kind === 'chat');
      if (!row) throw new Error('No real evidence record for reminder');
      const shown = await tools.show_private_notice.execute({ id: 'browser-approved-reminder', text: 'Confirm the mute button remains usable before release.', evidenceSeqs: [row.seq] });
      if (shown.isError) throw new Error(JSON.stringify(shown));
    });
    await page.getByRole('region', { name: 'Private reminder from Muse' }).getByRole('button', { name: 'Speak for me', exact: true }).click();
    await tab(guest, 'Transcript').click();
    await guest.getByText('Can we verify that the mute button remains usable?', { exact: true }).waitFor();
    await guest.getByText('Alice’s Muse', { exact: true }).waitFor();
    await guest.waitForFunction(() => window.__agentTest.audible > .01);
    const ownerMicOpen = await page.evaluate(() => Array.from(document.querySelectorAll('[data-local="true"] video')).some(v => v.srcObject?.getAudioTracks().some(t => t.enabled)));
    if (!ownerMicOpen) throw new Error('Speaking on behalf muted the owner microphone');
    const publicRequest = await page.evaluate(() => window.__agentTest.sends.filter(x => x.channel === 'oai-events' && x.value.type === 'response.item.create').findLast(x => JSON.stringify(x.value).includes('Speak once on behalf')));
    if (!publicRequest || JSON.stringify(publicRequest).includes('private-secret')) throw new Error('Public session reused private context');
    // A real local microphone signal interrupts approved Muse playback; no automatic resume.
    await page.evaluate(() => { for (const mic of window.__agentTest.microphones) mic.gain.gain.value = .18; });
    await page.waitForFunction(() => window.__agentTest.states.at(-1)?.floor === null);
    await page.evaluate(() => { for (const mic of window.__agentTest.microphones) mic.gain.gain.value = 0; });
    const sessionsAfterInterrupt = await page.evaluate(() => window.__agentTest.sessions.length);
    await page.waitForTimeout(500);
    if (await page.evaluate(() => window.__agentTest.sessions.length) !== sessionsAfterInterrupt) throw new Error('Muse resumed without fresh approval');
    await page.getByRole('button', { name: 'Collapse reminder', exact: true }).click();

    // Refresh restores only local Muse context and automatically recreates Muse, without opening Live.
    await page.reload(); await page.getByRole('button', { name: 'Join', exact: true }).click(); await personalReady(page); await tab(page, 'Muse').click();
    await page.getByRole('log', { name: 'Personal assistant transcript' }).getByText('private-secret', { exact: true }).waitFor();
    if (await page.evaluate(() => window.__agentTest.sessions.length)) throw new Error('Restoring Muse opened Live');
    // Also test the actual welcome -> agent-state order after a signaling interruption.
    const oldAgentId = await page.evaluate(() => window.__agentTest.states.at(-1).agents.find(a => a.config.kind === 'personal' && a.owner === window.__agentTest.you).id);
    await page.evaluate(() => window.__agentTest.sockets.find(s => s.readyState === WebSocket.OPEN)?.close());
    await page.waitForFunction(oldId => window.__agentTest.states.at(-1)?.agents.some(a => a.config.kind === 'personal' && a.owner === window.__agentTest.you && a.id !== oldId), oldAgentId);
    await page.getByRole('log', { name: 'Personal assistant transcript' }).getByText('private-secret', { exact: true }).waitFor();

    await tab(page, 'Room').click(); await tab(guest, 'Room').click();
    await page.getByRole('button', { name: 'Set up Omni', exact: true }).click();
    await page.getByRole('button', { name: 'Review settings', exact: true }).click();
    await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
    await Promise.all([page, guest].map(p => p.evaluate(() => window.__agentTest.audible = 0)));
    await page.getByRole('button', { name: 'Review now', exact: true }).click();
    await guest.getByTestId('chat-list').getByText('Consider an alternative before deciding.', { exact: true }).waitFor();
    const omniMessage = guest.getByTestId('chat-list').locator('li').filter({ hasText: 'Consider an alternative before deciding.' });
    if (!(await omniMessage.innerText()).includes('Omni')) throw new Error('Public suggestion is missing Omni attribution');
    for (const p of [page, guest]) {
      if (await p.evaluate(() => window.__agentTest.audible > .01)) throw new Error('Omni produced audible output');
      if (await p.evaluate(() => window.__agentTest.sends.some(x => x.channel === 'weave-in' && JSON.stringify(x.value).includes('SUPPRESSED PREPARATION')))) throw new Error('Silent Omni preparation leaked');
    }
    await guest.reload(); await guest.getByRole('button', { name: 'Join', exact: true }).click(); await personalReady(guest); await tab(guest, 'Room').click();
    await guest.getByTestId('chat-list').getByText('Consider an alternative before deciding.', { exact: true }).waitFor();
    if (await guest.getByTestId('chat-list').getByText('Consider an alternative before deciding.', { exact: true }).count() !== 1) throw new Error('Omni suggestion duplicated on recovery');
    await guest.setViewportSize({ width: 390, height: 844 });
    if (await guest.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Mobile document overflow');
    return { clients: 2, automaticChat: true, noLiveOnJoin: true, privateIsolation: true, privateRecovery: true, signalingRecovery: true, oneShotPublicSpeech: true, ownerAttribution: true, ownerMicOpen, omniRoomText: true, omniSilent: true, omniReplayDedup: true, mobileOverflow: false, provider: 'simulated GPT-Live WebRTC (no real provider call)' };
  } finally {
    await Promise.all([ownerContext, guestContext].map(context => context.close()));
  }
}
