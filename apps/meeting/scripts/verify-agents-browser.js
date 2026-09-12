async (page) => {
  const browser = page.context().browser();
  const setup = async (context) => {
    context.setDefaultTimeout(15_000);
    await context.grantPermissions(['microphone', 'camera']);
    await context.addInitScript(() => {
      localStorage.setItem('weave-in:settings', JSON.stringify({ captionsEnabled: false, languageCodes: [], mode: 'VERBATIM' }));
      window.__agentTest = { states: [], sends: [], sessions: [], incoming: [], peers: [], audible: 0 };
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
        constructor(...args) { super(...args); this.addEventListener('message', (e) => { try { const v=JSON.parse(e.data); if(v.type==='agent-state') window.__agentTest.states.push(v.state); } catch {} }); }
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
            const value=preparing?'Consider an alternative before deciding.':request.split('Current explicit request:').at(-1).includes('private-secret')?'Private response.':request.split('Current explicit request:').at(-1).includes('public-question')?'Public response.':'A useful perspective for the meeting.';
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
  const ownerContext=await browser.newContext({viewport:{width:1440,height:1000}}); page=await ownerContext.newPage();
  await setup(page.context()); await page.goto('http://127.0.0.1:5173');
  await page.getByRole('textbox',{name:'Display name',exact:true}).fill('Alice');
  await page.getByRole('button',{name:'Create a room',exact:true}).click();
  await page.getByRole('tab',{name:'Assistants',exact:true}).waitFor();
  const url=page.url();
  const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:1000}}),browser.newContext({viewport:{width:1440,height:1000}})]);
  const guests=[];
  for(let i=0;i<2;i++){
    await setup(contexts[i]);const p=await contexts[i].newPage();await p.goto(url);
    await p.getByRole('textbox',{name:'Display name',exact:true}).fill(i?'Carol':'Bob');
    await p.getByRole('button',{name:'Join',exact:true}).click();await p.getByRole('tab',{name:'Assistants',exact:true}).waitFor();guests.push(p);
  }
  const pages=[page,...guests];
  for(const p of pages){await p.getByRole('tab',{name:'Assistants',exact:true}).click();await p.getByRole('button',{name:'Enable assistant audio on this device',exact:true}).click();}
  await page.getByRole('button',{name:'Create an assistant',exact:true}).click();
  await page.getByRole('button',{name:'Review settings',exact:true}).click();await page.getByRole('button',{name:'Create assistant',exact:true}).click();
  await page.getByRole('textbox',{name:'Message your assistant',exact:true}).fill('private-secret');await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('log',{name:'Personal assistant transcript'}).getByText('Private response.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.agent-conversation')?.textContent.includes(' late.'));
  const privateLeaks=await page.evaluate(()=>window.__agentTest.sends.filter(x=>x.channel==='weave-in'&&JSON.stringify(x.value).includes('private-secret')));
  if(privateLeaks.length)throw new Error('Private input leaked to P2P');
  await page.getByRole('combobox',{name:/Conversation audience/}).selectOption('public');
  await page.getByRole('textbox',{name:'Message your assistant',exact:true}).fill('public-question');await page.getByRole('button',{name:'Send',exact:true}).click();
  await guests[0].getByRole('tab',{name:/Transcript/}).click();
  await guests[0].getByText(/Public response/).waitFor();
  await guests[0].waitForFunction(()=>window.__agentTest.audible>.01);
  await page.waitForFunction(()=>window.__agentTest.states.at(-1)?.floor===null);
  await page.getByRole('combobox',{name:/Conversation audience/}).selectOption('private');
  await page.getByRole('button',{name:'Talk to assistant',exact:true}).click();
  await page.getByRole('button',{name:'Finish speaking',exact:true}).waitFor();
  const micMuted=await page.evaluate(()=>Array.from(document.querySelectorAll('video')).some(v=>v.muted&&v.srcObject?.getAudioTracks().some(t=>!t.enabled)));
  if(!micMuted)throw new Error('Private microphone still in public stream');
  await page.getByRole('button',{name:'Finish speaking',exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByRole('combobox',{name:/Conversation audience/}).selectOption('public');
  await page.getByRole('button',{name:'Talk to assistant',exact:true}).click();
  await page.getByRole('button',{name:'Finish speaking',exact:true}).waitFor();
  const publicMic=await page.evaluate(()=>Array.from(document.querySelectorAll('video')).some(v=>v.muted&&v.srcObject?.getAudioTracks().some(t=>t.enabled)));
  if(!publicMic)throw new Error('Public owner speech is muted');
  await page.getByRole('button',{name:'Finish speaking',exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await Promise.all(pages.map(p=>p.evaluate(()=>window.__agentTest.audible=0)));
  await page.getByRole('button',{name:'Create an assistant',exact:true}).click();
  await page.getByRole('button',{name:'Review settings',exact:true}).click();await page.getByRole('button',{name:'Create assistant',exact:true}).click();
  await page.getByRole('button',{name:'Trigger review',exact:true}).click();
  await page.getByRole('button',{name:'Invite to speak',exact:true}).waitFor();
  const prepLeaks=await page.evaluate(()=>window.__agentTest.sends.filter(x=>x.channel==='weave-in'&&JSON.stringify(x.value).includes('SUPPRESSED PREPARATION')));
  if(prepLeaks.length)throw new Error('Preparation was published');
  if(await guests[1].evaluate(()=>window.__agentTest.audible>.01))throw new Error('Unapproved Group audio played');
  await guests[1].getByRole('tab',{name:'Chat',exact:true}).click();
  await guests[1].getByRole('textbox',{name:'Message',exact:true}).fill('latest-context-after-raising');
  await guests[1].getByRole('button',{name:'Send',exact:true}).click();
  await guests[1].getByRole('tab',{name:'Assistants',exact:true}).click();
  await guests[1].getByRole('button',{name:'Invite to speak',exact:true}).click();
  await guests[1].waitForFunction(()=>window.__agentTest.states.at(-1)?.agents.find(a=>a.config.kind==='group')?.phase==='speaking');
  await guests[1].waitForFunction(()=>window.__agentTest.audible>.01);
  const freshContext=await page.evaluate(()=>window.__agentTest.sends.some(x=>x.channel==='oai-events'&&x.value.type==='response.item.create'&&JSON.stringify(x.value).includes('latest-context-after-raising')&&JSON.stringify(x.value).includes('explicitly granted the floor')));
  if(!freshContext)throw new Error('Approval did not refresh context');
  await guests[1].getByRole('button',{name:'Expand panel',exact:true}).click();
  await guests[1].screenshot({path:'output/playwright/agents-desktop.png',fullPage:true});
  await page.close();
  await guests[1].waitForFunction(()=>{const a=window.__agentTest.states.at(-1)?.agents.find(a=>a.config.kind==='group');return a?.epoch>1&&a?.runner;});
  await guests[0].getByRole('tab',{name:'Assistants',exact:true}).click();
  await guests[0].getByRole('button',{name:'Invite to speak',exact:true}).waitFor();
  await guests[1].setViewportSize({width:390,height:844});
  await guests[1].screenshot({path:'output/playwright/agents-mobile.png',fullPage:true});
  const overflow=await guests[1].evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  if(overflow)throw new Error('Mobile document overflow');
  await Promise.all([ownerContext,...contexts].map(c=>c.close()));
  return ({clients:3,privateIsolation:true,lateTranscripts:true,publicDelivery:true,remoteAudio:true,publicMic:true,freshApprovalContext:true,privateMicMuted:true,silentPreparation:true,approval:true,automaticTakeover:true,mobileOverflow:false,provider:'simulated GPT-Live WebRTC'});
}
