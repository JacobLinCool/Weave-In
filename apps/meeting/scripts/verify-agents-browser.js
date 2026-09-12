async (page, origin = 'http://127.0.0.1:8788') => {
  const browser = page.context().browser();
  const setup = async (context) => {
    context.setDefaultTimeout(15_000);
    // This UI harness uses local peer connectivity, not the external TURN service.
    await context.route('**/api/ice-servers', (route) => route.fulfill({ json: { ok: true, expiresAt: Date.now() + 86_400_000, iceServers: [{ urls: 'turn:127.0.0.1:9', username: 'test', credential: 'test' }] } }));
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
            const value=preparing?'Consider an alternative before deciding.':request.split('Current explicit request:').at(-1).includes('private-secret')?'Private response.':request.split('Current explicit request:').at(-1).includes('Speak once on behalf')?JSON.parse(request.split('Approved message: ').at(-1)) :'A useful perspective for the meeting.';
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
            if(event.type==='response.create'){if(body.session.instructions.includes('prepares a suggestion silently'))setTimeout(answer,800);else answer();}
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

    const reply = page.locator('.agent-line--assistant').filter({ hasText: 'Private response.' }).first();
    const sendReply = reply.getByRole('button', { name: 'Send to everyone', exact: true });
    await sendReply.waitFor();
    await page.mouse.move(0, 0);
    if (await sendReply.evaluate(el => getComputedStyle(el).opacity) !== '0') throw new Error('Reply Send is not hidden before hover');
    const idleBackground = await reply.evaluate(el => getComputedStyle(el).backgroundColor);
    await reply.hover();
    if ((await sendReply.innerText()).trim()) throw new Error('Reply Send must be icon only');
    if (await reply.evaluate(el => getComputedStyle(el).backgroundColor) === idleBackground) throw new Error('Reply hover has no background feedback');
    const replyBounds = await reply.boundingBox(); const iconBounds = await sendReply.boundingBox();
    if (Math.abs(replyBounds.y + replyBounds.height / 2 - iconBounds.y - iconBounds.height / 2) > 1) throw new Error('Reply Send is not vertically centered');
    await page.screenshot({ path: 'output/playwright/muse-send-hover.png' });
    if (await sendReply.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Reply Send is missing on hover');
    await sendReply.hover();
    await reply.getByRole('tooltip', { name: 'Read aloud to everyone' }).waitFor();
    await page.keyboard.press('Escape');
    if (await reply.getByRole('tooltip').count()) throw new Error('Hovered Send tooltip did not dismiss on Escape without button focus');
    await page.getByRole('textbox', { name: 'Message Muse', exact: true }).focus();
    await page.mouse.move(0, 0); await sendReply.focus();
    await reply.getByRole('tooltip', { name: 'Read aloud to everyone' }).waitFor();
    if (await sendReply.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Reply Send is missing on keyboard focus');
    await page.screenshot({ path: 'output/playwright/muse-send-desktop.png' });
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    // Check the native touch media query against the actual panel styles without opening another meeting.
    const touchPage = await touch.newPage();
    await touchPage.goto(origin);
    const panelStyles = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(rule => rule.cssText); } catch { return []; } }).join('\n'));
    await touchPage.setContent('<main class="agent-panel"><article class="agent-line agent-line--assistant"><header>Muse</header><p>Please include a review step.</p><button class="agent-line__send" aria-label="Send to everyone"></button></article></main>');
    await touchPage.addStyleTag({ content: panelStyles });
    const touchSend = touchPage.locator('.agent-line__send');
    if (await touchSend.evaluate(el => getComputedStyle(el).opacity) !== '0') throw new Error('Touch Send is visible before interacting');
    await touchPage.locator('.agent-line').tap();
    if (await touchSend.evaluate(el => getComputedStyle(el).opacity) !== '1' || (await touchSend.boundingBox()).height < 44) throw new Error('Touch Send is not visible and tappable');
    await touch.close();
    await sendReply.press('Enter');
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    await tab(guest, 'Transcript').click();
    await guest.getByText('Private response. late.', { exact: true }).waitFor();
    await guest.waitForFunction(() => window.__agentTest.audible > .01);
    const approvedRequest = await page.evaluate(() => window.__agentTest.sends.filter(x => x.channel === 'oai-events' && x.value.type === 'response.item.create').findLast(x => JSON.stringify(x.value).includes('Speak once on behalf')));
    if (!approvedRequest || JSON.stringify(approvedRequest).includes('private-secret')) throw new Error('Reply Send exposed private context');
    await page.waitForFunction(() => window.__agentTest.states.at(-1)?.floor === null);

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
    await guest.getByText('Confirm the mute button remains usable before release.', { exact: true }).waitFor();
    await guest.getByRole('listitem').filter({ hasText: 'Confirm the mute button remains usable before release.' }).getByText('Alice’s Muse', { exact: true }).waitFor();
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
    // Inject a room signal to check its receiver; no automatic signal producer exists yet.
    await page.evaluate(() => {
      const group = window.__agentTest.states.at(-1).agents.find(a => a.config.kind === 'group');
      const socket = window.__agentTest.sockets.find(s => s.readyState === WebSocket.OPEN && new URL(s.url).pathname.endsWith('/connect'));
      socket.send(JSON.stringify({ type: 'agent-signal', id: group.id }));
    });
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
    return { replySend: true, replyHover: true, replyKeyboard: true, replyTouch: true, selectedMessageOnly: true, oneClickGroupAdd: true, rightAlignedAdd: true, fullPanelSettings: true, backWithoutSaving: true, reminderControlsRemoved: true, groupRemoval: true, clients: 2, directMuseTab: true, groupInRoom: true, allMembersConfigureGroup: true, groupBorderGlow: true, injectedSystemSignal: true, automaticSystemSignal: false, editSettings: true, automaticChat: true, noLiveOnJoin: true, privateIsolation: true, privateRecovery: true, signalingRecovery: true, oneShotPublicSpeech: true, ownerAttribution: true, ownerMicOpen, omniRoomText: true, omniSilent: true, omniReplayDedup: true, mobileOverflow: false, provider: 'simulated GPT-Live WebRTC (no real provider call)', relay: 'mocked provisioning; local peer connectivity' };
  } finally {
    await Promise.all([ownerContext, guestContext].map(context => context.close()));
  }
}
