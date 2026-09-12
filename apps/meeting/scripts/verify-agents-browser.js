async (page, origin = 'http://127.0.0.1:8788', options = {}) => {
  const browser = page.context().browser();
  const setup = async (context) => {
    context.setDefaultTimeout(15_000);
    // This UI harness uses local peer connectivity, not the external TURN service.
    await context.route('**/api/ice-servers', (route) => route.fulfill({ json: { ok: true, expiresAt: Date.now() + 86_400_000, iceServers: [{ urls: 'turn:127.0.0.1:9', username: 'test', credential: 'test' }] } }));
    await context.grantPermissions(['microphone', 'camera']);
    await context.addInitScript(({ realProvider, scenario }) => {
      localStorage.setItem('weave-in:settings', JSON.stringify({ captionsEnabled: false, languageCodes: [], mode: 'VERBATIM' }));
      window.__agentTest = { states: [], sends: [], sessions: [], incoming: [], peers: [], sockets: [], microphones: [], audible: 0, tools: {}, reasoning: [] };
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
      const inspectedChannels = new WeakSet();
      const originalSend = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function(data) { if(this.label === 'oai-events' && !inspectedChannels.has(this)) { inspectedChannels.add(this); this.addEventListener('message', ({data}) => { try { const e=JSON.parse(data); if(e.type==='response.event'&&e.event?.type==='response.output_text.delta') window.__agentTest.reasoning.push(e.event.delta); } catch {} }); } if(typeof data==='string') { try { const v=JSON.parse(data); window.__agentTest.sends.push({channel:this.label,value:v}); } catch {} } return originalSend.call(this,data); };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (!String(input).match(/\/agents\/[^/]+\/live$/)) return originalFetch(input, init);
        const body=JSON.parse(init.body); window.__agentTest.sessions.push(body);
        if (realProvider) return originalFetch(input, init);
        const pc=new RTCPeerConnection(); window.__agentTest.peers.push(pc); pc.onconnectionstatechange=()=>window.__agentTest.incoming.push(pc.connectionState); const ac=new AudioContext(); await ac.resume();
        const osc=ac.createOscillator(); const gain=ac.createGain(); gain.gain.value=0;
        const dest=ac.createMediaStreamDestination(); osc.connect(gain); gain.connect(dest); osc.start();
        pc.addTrack(dest.stream.getAudioTracks()[0],dest.stream);
        pc.ondatachannel=({channel:dc})=> { window.__agentTest.incoming.push('datachannel');
          const emit=(event)=>{ if(dc.readyState==='open') dc.send(JSON.stringify(event)); };
          let request=''; let responding=false; let reviewContext={};
          const answer=()=> {
            if(responding)return;responding=true;
            const preparing=body.session.instructions.includes('prepares a suggestion silently');
            const records=(reviewContext.meeting??[]).filter(r=>(r.kind==='chat'||r.kind==='transcript')&&!r.agent);
            const target=reviewContext.participants?.find(p=>p.name==='Carol');
            const texts={ convergence:'Consider an alternative before deciding.', drift:'Should we return to choosing the database rather than planning a holiday?', float:'Carol, what evidence would help us choose the launch date?', echo:'What concrete evidence supports approving this proposal?' };
            const value=preparing?JSON.stringify(scenario==='none'?{kind:'none',severity:0,evidenceSeqs:[],targetPeerId:null,text:''}:{kind:scenario,severity:.8,evidenceSeqs:[records.at(-4)?.seq,records.at(-1)?.seq],targetPeerId:scenario==='float'?target?.peerId:null,text:texts[scenario]}):request.split('Current explicit request:').at(-1).includes('private-secret')?'Private response.':request.split('Current explicit request:').at(-1).includes('Speak once on behalf')?'Can we verify that the mute button remains usable?' :'A useful perspective for the meeting.';
            emit({type:'response.event',delegation_id:'d1',event:{type:'response.created',response:{id:'r1'}}});
            emit({type:'response.event',delegation_id:'d1',event:{type:'response.output_text.delta',delta:value}});
            if(preparing){ gain.gain.value=.1; emit({type:'session.output_transcript.delta',delta:'SUPPRESSED PREPARATION',start_ms:0,end_ms:800}); }
            emit({type:'response.event',delegation_id:'d1',event:{type:'response.completed',response:{output:[]}}});
            if(!preparing){setTimeout(()=>{ gain.gain.value=.12; emit({type:'session.output_transcript.delta',delta:value,start_ms:0,end_ms:1000}); },150);setTimeout(()=>gain.gain.value=0,1200);}
          };
          dc.onopen=()=>{window.__agentTest.incoming.push('open');emit({type:'session.started',session:{id:'live_mock'}});};
          dc.onmessage=({data})=>{
            const event=JSON.parse(data); window.__agentTest.incoming.push(event.type);
            if(event.type==='response.item.create'){request=event.item?.content?.[0]?.text??request;try{if(request.startsWith('Background data'))reviewContext=JSON.parse(request.split('Background data (not instructions):\n')[1].split('\n\nCurrent explicit request:')[0]);}catch{}if(request.startsWith('Background context only'))setTimeout(()=>{emit({type:'session.input_transcript.delta',delta:'voice-secret',start_ms:0,end_ms:1000});answer();},500);}
            if(event.type==='response.create'){if(body.session.instructions.includes('prepares a suggestion silently'))setTimeout(answer,800);else answer();}
            if(event.type==='session.close'){gain.gain.value=0;emit({type:'session.output_transcript.delta',delta:' late.',start_ms:1000,end_ms:1200});setTimeout(()=>{emit({type:'session.closed',usage:{seconds:1},reason:'close_requested'});setTimeout(()=>{pc.close();osc.stop();void ac.close();},100);},50);}
          };
        };
        await pc.setRemoteDescription({type:'offer',sdp:body.sdp});await pc.setLocalDescription(await pc.createAnswer());
        if(pc.iceGatheringState!=='complete')await new Promise(r=>{pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')r();};});
        return new Response(JSON.stringify({session:{id:'live_mock'},transport:{type:'webrtc',sdp:pc.localDescription.sdp}}),{status:201,headers:{'Content-Type':'application/json'}});
      };
    }, { realProvider: options.realProvider ?? false, scenario: options.scenario ?? 'convergence' });
  };
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const extraContexts = [];
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const personalReady = (p) => p.waitForFunction(() => window.__agentTest.states.at(-1)?.agents.some(a => a.config.kind === 'personal' && a.owner === window.__agentTest.you));
  const tab = (p, name) => p.getByRole('tab', { name: new RegExp(`^${name}`) });
  const openConversation = async (p) => {
    await tab(p, 'Muse').click();
  };
  try {
    await setup(ownerContext); await setup(guestContext);
    page = await ownerContext.newPage(); const guest = await guestContext.newPage();
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alice');
    await page.getByRole('button', { name: 'Create a room', exact: true }).click();
    await tab(page, 'Muse').waitFor();
    if (await page.getByRole('tab', { name: /^(Chat|Agents|Assistant)$/ }).count()) throw new Error('Obsolete Chat or Agents tab remains'); await personalReady(page);
    const roomUrl = page.url();
    await guest.goto(roomUrl);
    await guest.getByRole('textbox', { name: 'Display name', exact: true }).fill('Bob');
    await guest.getByRole('button', { name: 'Join', exact: true }).click(); await personalReady(guest);
    if (options.groupOnly) {
      const scenario = options.scenario ?? 'convergence';
      let third;
      if (scenario === 'float') {
        const thirdContext = await browser.newContext(); extraContexts.push(thirdContext); await setup(thirdContext);
        third = await thirdContext.newPage(); await third.goto(roomUrl);
        await third.getByRole('textbox', { name: 'Display name', exact: true }).fill('Carol');
        await third.getByRole('button', { name: 'Join', exact: true }).click(); await personalReady(third);
      }
      for (const p of [page, guest, ...(third ? [third] : [])]) await tab(p, 'Room').click();
      await page.getByRole('button', { name: 'Add Omni', exact: true }).click();
      await page.getByRole('button', { name: 'Omni settings', exact: true }).waitFor();
      const discussions = {
        convergence: ["Our goal is to decide whether to release the payment service tomorrow.", "I object: the duplicate-charge test still fails and customers could be charged twice.", "Fixing that would delay the release; can we consider waiting?", "No more alternatives. Approve tomorrow's release now without fixing the duplicate-charge failure."],
        drift: ['The sole goal today is to choose PostgreSQL or MySQL for the billing database before our deadline.', 'PostgreSQL supports the transaction constraints we need; we still have not made a choice.', 'Leaving databases aside, let me spend the rest of this meeting describing beach hotels and vacation destinations.', 'The beach hotel has excellent cocktails and a rooftop pool.', 'Now let us compare tourist restaurants, sightseeing tours and holiday luggage.', 'More holiday ideas: which beaches, souvenirs and flight meals do we like?'],
        float: ['We need to choose the launch date; I favor Friday.', 'Friday is best because our marketing campaign starts then.', 'I will continue: our sales team also prefers Friday.', 'I have more to say: the current operations schedule favors Friday.', 'Let me keep explaining my reasoning for Friday.', 'I will keep the floor: I want Friday, and I have still more arguments to explain.'],
        echo: ['The proposal is to adopt Vendor X for the production platform; we have not discussed its costs, reliability or evidence yet.', 'Yes, Vendor X.', 'Agreed, Vendor X.', 'Absolutely, I agree with Vendor X.', 'Yes, same here.', 'Agreed, exactly the same.'],
        none: ['Should we release the service tomorrow or wait?', 'I am worried that duplicate-charge testing is not complete.', 'We completed the test today: all duplicate-charge cases passed, and the rollback drill passed too.', 'That resolves my concern. After comparing both dates, I support tomorrow with the tested rollback plan.'],
      };
      const turns = discussions[scenario];
      for (let i = 0; i < turns.length; i++) {
        const sender = scenario === 'float' || i % 2 === 0 ? page : guest;
        await sender.getByPlaceholder('Send a message…', { exact: true }).fill(turns[i]);
        await sender.getByPlaceholder('Send a message…', { exact: true }).press('Enter');
        await page.getByTestId('chat-list').getByText(turns[i], { exact: true }).waitFor();
        await guest.getByTestId('chat-list').getByText(turns[i], { exact: true }).waitFor();
      }
      await page.waitForFunction(() => window.__agentTest.states.some(s => s.agents.some(a => a.config.kind === 'group' && a.phase === 'preparing')), null, { timeout: 45000 });
      await page.waitForFunction(() => window.__agentTest.states.at(-1)?.agents.some(a => a.config.kind === 'group' && ['idle','waiting'].includes(a.phase)), null, { timeout: 90000 });
      const result = await page.evaluate(() => {
        const state = window.__agentTest.states.at(-1);
        return { signal: state.signal, reasoning: window.__agentTest.reasoning.join(''), publications: state.automation.published, audible: window.__agentTest.audible, sessions: window.__agentTest.sessions.length,
          messages: [...new Map(window.__agentTest.sends.filter(x => x.channel === 'weave-in' && x.value.type === 'agent-line').map(x => [x.value.line.id, x.value.line.text])).values()] };
      });
      if (result.audible > .01) throw new Error('Group review produced audible audio');
      if (scenario === 'none') { if (result.publications || result.messages.length) throw new Error('An answered concern produced a public intervention'); }
      else {
        if (result.signal?.kind !== scenario || result.publications !== 1 || result.messages.length !== 1) throw new Error(JSON.stringify({ scenario, result, error: await page.locator('.agent-error').allTextContents() }));
        await guest.getByTestId('chat-list').getByText(result.messages[0], { exact: true }).waitFor();
      }
      return { scenario, provider: options.realProvider ? 'real GPT-Live' : 'simulated GPT-Live', ...result };
    }
    for (const p of [page, guest]) {
      if (await p.evaluate(() => window.__agentTest.sessions.length)) throw new Error('Live opened automatically on room entry');
    }
    await openConversation(guest);
    await guest.getByRole('button', { name: 'Talk to Muse', exact: true }).click();
    await guest.getByRole('button', { name: 'Stop', exact: true }).click();
    await openConversation(page);
    if (await page.getByText('Only you can see this chat', { exact: true }).count()) throw new Error('Removed personal chat subtitle remains');
    if (await page.getByRole('button', { name: 'Expand panel', exact: true }).count()) throw new Error('Redundant panel expansion remains');
    if (await page.locator('.agent-personal').getByRole('button', { name: 'Stop', exact: true }).count()) throw new Error('Idle Chat shows Stop');
    await page.getByRole('textbox', { name: 'Message Muse', exact: true }).fill('private-secret');
    await page.locator('.agent-personal').getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('log', { name: 'Muse transcript' }).getByText(/Private response/).waitFor();
    await page.getByRole('log', { name: 'Muse transcript' }).getByText(/late/).waitFor();
    if (await page.evaluate(() => window.__agentTest.sends.some(x => x.channel === 'weave-in' && /private-secret|Private response/.test(JSON.stringify(x.value))))) throw new Error('Private Chat leaked to peers');
    if (await guest.locator('body').innerText().then(t => /private-secret|Private response/.test(t))) throw new Error('Guest saw private Chat');

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
    // A real local microphone signal interrupts approved Chat playback; no automatic resume.
    await page.evaluate(() => { for (const mic of window.__agentTest.microphones) mic.gain.gain.value = .18; });
    await page.waitForFunction(() => window.__agentTest.states.at(-1)?.floor === null);
    await page.evaluate(() => { for (const mic of window.__agentTest.microphones) mic.gain.gain.value = 0; });
    const sessionsAfterInterrupt = await page.evaluate(() => window.__agentTest.sessions.length);
    await page.waitForTimeout(500);
    if (await page.evaluate(() => window.__agentTest.sessions.length) !== sessionsAfterInterrupt) throw new Error('Chat resumed without fresh approval');
    await page.getByRole('button', { name: 'Collapse reminder', exact: true }).click();

    // Refresh restores only local Chat context and automatically recreates Chat, without opening Live.
    await page.reload(); await page.getByRole('button', { name: 'Join', exact: true }).click(); await personalReady(page); await openConversation(page);
    await page.getByRole('log', { name: 'Muse transcript' }).getByText('private-secret', { exact: true }).waitFor();
    if (await page.evaluate(() => window.__agentTest.sessions.length)) throw new Error('Restoring Chat opened Live');
    // Also test the actual welcome -> agent-state order after a signaling interruption.
    const oldAgentId = await page.evaluate(() => window.__agentTest.states.at(-1).agents.find(a => a.config.kind === 'personal' && a.owner === window.__agentTest.you).id);
    await page.evaluate(() => {
      const socket = window.__agentTest.sockets.find(s => s.readyState === WebSocket.OPEN && new URL(s.url).pathname.endsWith('/connect'));
      if (!socket) throw new Error('No open room signaling socket');
      socket.close();
    });
    await page.waitForFunction(oldId => window.__agentTest.states.at(-1)?.agents.some(a => a.config.kind === 'personal' && a.owner === window.__agentTest.you && a.id !== oldId), oldAgentId);
    await page.getByRole('log', { name: 'Muse transcript' }).getByText('private-secret', { exact: true }).waitFor();

    await tab(page, 'Room').click(); await tab(guest, 'Room').click();
    await tab(page, 'Room').click();
    const add = page.getByRole('button', { name: 'Add Omni', exact: true });
    const addBox = await add.boundingBox();
    const titleBox = await page.getByRole('heading', { name: 'Omni', exact: true }).boundingBox();
    if (!addBox || !titleBox || addBox.x < titleBox.x + titleBox.width || Math.abs((addBox.y + addBox.height / 2) - (titleBox.y + titleBox.height / 2)) > 2) throw new Error('Group add button is not aligned with the title');
    if (await page.getByText('Not added. One shared agent provides public text suggestions in Room.', { exact: true }).count()) throw new Error('Removed group description remains');
    await page.screenshot({ path: 'output/playwright/group-add-right.png' });
    await add.click();
    await page.getByRole('button', { name: 'Omni settings', exact: true }).waitFor();
    const addedSettingsBox = await page.getByRole('button', { name: 'Omni settings', exact: true }).boundingBox();
    if (!addedSettingsBox || addedSettingsBox.width !== addBox.width || addedSettingsBox.height !== addBox.height) throw new Error('Omni add and settings button sizes differ');
    if (await page.locator('.agent-form').count()) throw new Error('Adding a group opened configuration instead of adding it');
    await page.waitForFunction(() => window.__agentTest.states.at(-1)?.agents.some(a => a.config.kind === 'group' && a.config.language === 'auto'));
    await page.getByRole('button', { name: 'Omni settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Room', exact: true }).waitFor();
    if (await page.getByTestId('chat-panel').isVisible()) throw new Error('Room chat is still visible behind group settings');
    await page.screenshot({ path: 'output/playwright/group-settings-page.png' });
    await page.getByRole('textbox', { name: 'Response language', exact: true }).fill('Discard this edit');
    await page.getByRole('button', { name: 'Back to Room', exact: true }).click();
    await page.getByTestId('chat-panel').waitFor();
    await page.getByRole('button', { name: 'Omni settings', exact: true }).click();
    if (await page.getByRole('textbox', { name: 'Response language', exact: true }).inputValue() !== 'auto') throw new Error('Back saved an unsubmitted edit');
    await page.getByRole('button', { name: 'Back to Room', exact: true }).click();
    // The assistant opens directly into chat; settings retain identity and history.
    await openConversation(page);
    await page.getByRole('textbox', { name: 'Message Muse', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Muse settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Muse', exact: true }).waitFor();
    if (await page.getByRole('tabpanel', { name: 'Private reminders', exact: true }).isVisible()) throw new Error('Reminders still visible in personal settings');
    await page.screenshot({ path: 'output/playwright/personal-settings-page.png' });
    await page.getByRole('textbox', { name: 'Response language', exact: true }).fill('繁體中文');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('log', { name: 'Muse transcript' }).getByText('private-secret', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Muse settings', exact: true }).click();
    if (await page.getByRole('textbox', { name: 'Response language', exact: true }).inputValue() !== '繁體中文') throw new Error('Personal settings did not persist');
    await page.getByRole('button', { name: 'Back to Muse', exact: true }).click();
    if (await page.getByRole('button', { name: /^(Pause reminders|Resume reminders|Hide chat & reminders|Show chat & reminders)$/ }).count()) throw new Error('Removed reminder controls remain');
    if (await page.getByText('Hiding removes private chat and reminders', { exact: false }).count()) throw new Error('Removed hide explanation remains');
    await page.screenshot({ path: 'output/playwright/assistant-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'output/playwright/assistant-mobile.png' });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Muse mobile document overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await tab(page, 'Room').click();
    const groupSection = page.getByRole('region', { name: 'Omni', exact: true });
    await groupSection.getByRole('button', { name: 'Omni settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Response language', exact: true }).fill('English');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor({ state: 'detached' });
    // Another participant can edit the same Omni in Room.
    const guestGroup = guest.getByRole('region', { name: 'Omni', exact: true });
    await guestGroup.getByRole('button', { name: 'Omni settings', exact: true }).click();
    if (await guest.getByRole('textbox', { name: 'Response language', exact: true }).inputValue() !== 'English') throw new Error('Group settings did not synchronize');
    await guest.getByRole('textbox', { name: 'Response language', exact: true }).fill('日本語');
    await guest.getByRole('button', { name: 'Save settings', exact: true }).click();
    await guest.getByRole('button', { name: 'Save settings', exact: true }).waitFor({ state: 'detached' });
    await groupSection.getByRole('button', { name: 'Omni settings', exact: true }).click();
    if (await page.getByRole('textbox', { name: 'Response language', exact: true }).inputValue() !== '日本語') throw new Error('Guest group update was not applied to the owner');
    await page.getByRole('button', { name: 'Back to Room', exact: true }).click();
    const settingsBox = await groupSection.getByRole('button', { name: 'Omni settings', exact: true }).boundingBox();
    const removeButton = groupSection.getByRole('button', { name: 'Remove Omni', exact: true });
    const removeBox = await removeButton.boundingBox();
    if (!settingsBox || !removeBox || removeBox.x <= settingsBox.x || (await removeButton.innerText()).trim()) throw new Error('Remove is not an icon to the right of settings');
    await page.screenshot({ path: 'output/playwright/group-room-desktop.png' });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: 'output/playwright/group-room-mobile.png' });
    if (await guest.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Room mobile document overflow');
    await guest.setViewportSize({ width: 1440, height: 1000 });
    await Promise.all([page, guest].map(p => p.evaluate(() => window.__agentTest.audible = 0)));
    if (await page.getByRole('button', { name: 'Trigger review', exact: true }).count()) throw new Error('Removed trigger button remains');
    if (await page.getByText('Listening to public meeting context', { exact: true }).count()) throw new Error('Removed idle text remains');
    // Public chat drives the real timer; no control signal is injected.
    for (const [p, text] of [[page, 'Should we launch tomorrow?'], [guest, 'The safety test is still failing.'], [page, 'We could delay to fix it.'], [guest, 'Let us approve launching now without resolving the safety failure.']]) {
      await p.getByPlaceholder('Send a message…', { exact: true }).fill(text);
      await p.getByPlaceholder('Send a message…', { exact: true }).press('Enter');
      await page.getByTestId('chat-list').getByText(text, { exact: true }).waitFor();
      await guest.getByTestId('chat-list').getByText(text, { exact: true }).waitFor();
    }
    await page.locator('.agent-panel--group.agent-panel--active').waitFor();
    await guest.locator('.agent-panel--group.agent-panel--active').waitFor();
    await page.waitForFunction(() => { const card = document.querySelector('.agent-panel--group.agent-panel--active'); return card && getComputedStyle(card).borderTopColor === 'rgb(233, 180, 76)' && getComputedStyle(card).boxShadow !== 'none'; });
    await page.screenshot({ path: 'output/playwright/group-room-active.png' });
    await guest.getByTestId('chat-list').getByText('Consider an alternative before deciding.', { exact: true }).waitFor();
    await page.locator('.agent-panel--group:not(.agent-panel--active)').waitFor();
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
    await tab(page, 'Room').click();
    await groupSection.getByRole('button', { name: 'Remove Omni', exact: true }).click();
    await page.getByRole('button', { name: 'Add Omni', exact: true }).waitFor();
    await tab(guest, 'Room').click();
    await guest.getByRole('button', { name: 'Add Omni', exact: true }).waitFor();
    return { oneClickGroupAdd: true, rightAlignedAdd: true, fullPanelSettings: true, backWithoutSaving: true, reminderControlsRemoved: true, groupRemoval: true, clients: 2, directMuseTab: true, groupInRoom: true, allMembersConfigureGroup: true, groupBorderGlow: true, injectedSystemSignal: false, automaticSystemSignal: true, editSettings: true, automaticChat: true, noLiveOnJoin: true, privateIsolation: true, privateRecovery: true, signalingRecovery: true, oneShotPublicSpeech: true, ownerAttribution: true, ownerMicOpen, omniRoomText: true, omniSilent: true, omniReplayDedup: true, mobileOverflow: false, provider: 'simulated GPT-Live WebRTC (no real provider call)', relay: 'mocked provisioning; local peer connectivity' };
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({ events: window.__agentTest?.incoming.slice(-20), audible: window.__agentTest?.audible, group: window.__agentTest?.states.at(-1)?.agents.find(a => a.config.kind === 'group'), errors: [...document.querySelectorAll('.agent-error')].map(e => e.textContent) })).catch(() => null);
    throw new Error(`${String(error)} ${JSON.stringify(diagnostics)}`);
  } finally {
    await Promise.all([ownerContext, guestContext, ...extraContexts].map(context => context.close()));
  }
}
