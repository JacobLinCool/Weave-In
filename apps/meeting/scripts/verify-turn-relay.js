// Opt-in Chromium check: open the configured app, interact with the page to allow
// Web Audio, then run this file with Playwright CLI `run-code --filename ...`.
// Uses synthetic media only. All three modes require TURN; direct ICE cannot pass.
async (page) => {
  const report = await page.evaluate(async () => {
    let response;
    try {
      response = await fetch('/api/ice-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { passed: false, error: 'ICE_SERVERS_REQUEST_FAILED' };
    }
    if (!response.ok) return { passed: false, error: `ICE_SERVERS_HTTP_${response.status}` };

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { passed: false, error: 'ICE_SERVERS_RESPONSE_INVALID' };
    }
    if (!payload?.ok || !Array.isArray(payload.iceServers) || !payload.iceServers.every((server) =>
      server && typeof server === 'object' && (typeof server.urls === 'string' ||
        (Array.isArray(server.urls) && server.urls.every((url) => typeof url === 'string'))))) {
      return { passed: false, error: 'ICE_SERVERS_RESPONSE_INVALID' };
    }

    const modes = [
      { name: 'default', accepts: (url) => /^turns?:/iu.test(url) },
      { name: 'tcp-only', accepts: (url) => /^turn:/iu.test(url) && /[?&]transport=tcp(?:&|$)/iu.test(url), protocol: 'tcp' },
      { name: 'tls-443-only', accepts: (url) => /^turns:[^?]+:443(?:\?|$)/iu.test(url), protocol: 'tls' },
    ];

    async function verifyMode(mode) {
      const iceServers = payload.iceServers.flatMap((server) => {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
          .filter((url) => typeof url === 'string' && mode.accepts(url));
        return urls.length ? [{ ...server, urls }] : [];
      });
      if (!iceServers.length) return { mode: mode.name, passed: false, error: 'REQUIRED_TURN_URL_MISSING' };

      const peers = [];
      const tracks = [];
      const channels = [];
      let oscillator;
      let audio;
      let drawTimer;
      let deadline;
      let closed = false;
      let stage = 'PEER_SETUP';
      let rejectFailure;
      const failure = new Promise((_, reject) => { rejectFailure = reject; });
      const fail = (code) => { if (!closed) rejectFailure(new Error(code)); };

      async function exercise() {
        const configuration = { iceServers, iceTransportPolicy: 'relay', bundlePolicy: 'max-bundle' };
        const sender = new RTCPeerConnection(configuration);
        peers.push(sender);
        const receiver = new RTCPeerConnection(configuration);
        peers.push(receiver);

        for (const peer of peers) {
          peer.onconnectionstatechange = () => {
            if (peer.connectionState === 'failed') fail('PEER_CONNECTION_FAILED');
          };
        }
        const pending = new Map(peers.map((peer) => [peer, []]));
        for (const [source, target] of [[sender, receiver], [receiver, sender]]) {
          source.onicecandidate = ({ candidate }) => {
            if (!candidate || closed) return;
            if (candidate.type !== 'relay') return fail('NON_RELAY_CANDIDATE');
            if (target.remoteDescription) {
              target.addIceCandidate(candidate).catch(() => fail('ICE_CANDIDATE_REJECTED'));
            } else {
              pending.get(target).push(candidate);
            }
          };
        }
        async function setRemote(peer, description) {
          await peer.setRemoteDescription(description);
          for (const candidate of pending.get(peer).splice(0)) await peer.addIceCandidate(candidate);
        }

        stage = 'SYNTHETIC_MEDIA';
        audio = new AudioContext();
        const destination = audio.createMediaStreamDestination();
        tracks.push(...destination.stream.getTracks());
        oscillator = audio.createOscillator();
        oscillator.frequency.value = 440;
        oscillator.connect(destination);
        oscillator.start();
        // No device access and no connection to the speaker output.
        if (audio.state !== 'running') {
          stage = 'AUDIO_ACTIVATION_REQUIRED';
          await audio.resume();
        }
        if (closed) return;
        stage = 'SYNTHETIC_MEDIA';
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext('2d');
        let frame = 0;
        const draw = () => {
          context.fillStyle = `hsl(${frame++ % 360} 80% 50%)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
        };
        draw();
        const video = canvas.captureStream(10);
        tracks.push(...video.getTracks());
        drawTimer = setInterval(draw, 100);
        const stream = new MediaStream(tracks);
        for (const track of tracks) sender.addTrack(track, stream);
        receiver.ontrack = ({ track }) => tracks.push(track);

        stage = 'DATA_CHANNEL';
        const outbound = sender.createDataChannel('turn-verification');
        channels.push(outbound);
        outbound.binaryType = 'arraybuffer';
        // Multiple chunks exercise SCTP transfer without filling its send buffer.
        const chunkSize = 16_384;
        const chunks = 8;
        const expectedBytes = chunkSize * chunks;
        let receivedBytes = 0;
        let echoedBytes = 0;
        let resolveTransfer;
        const transferred = new Promise((resolve) => { resolveTransfer = resolve; });
        receiver.ondatachannel = ({ channel }) => {
          channels.push(channel);
          channel.binaryType = 'arraybuffer';
          channel.onerror = () => fail('DATA_CHANNEL_FAILED');
          channel.onmessage = ({ data }) => {
            if (!(data instanceof ArrayBuffer) || !new Uint8Array(data).every((value) => value === 37)) {
              return fail('DATA_INTEGRITY_FAILED');
            }
            receivedBytes += data.byteLength;
            try { channel.send(data); } catch { fail('DATA_SEND_FAILED'); }
          };
        };
        outbound.onerror = () => fail('DATA_CHANNEL_FAILED');
        outbound.onmessage = ({ data }) => {
          if (!(data instanceof ArrayBuffer) || !new Uint8Array(data).every((value) => value === 37)) {
            return fail('DATA_INTEGRITY_FAILED');
          }
          echoedBytes += data.byteLength;
          if (echoedBytes === expectedBytes) resolveTransfer();
          else if (echoedBytes > expectedBytes) fail('DATA_INTEGRITY_FAILED');
        };
        outbound.onopen = () => {
          try {
            const chunk = new Uint8Array(chunkSize).fill(37);
            for (let index = 0; index < chunks; index++) outbound.send(chunk);
          } catch { fail('DATA_SEND_FAILED'); }
        };

        stage = 'ICE_NEGOTIATION';
        await sender.setLocalDescription(await sender.createOffer());
        await setRemote(receiver, sender.localDescription);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await setRemote(sender, receiver.localDescription);
        stage = 'DATA_TRANSFER';
        await transferred;
        if (closed) return;

        function selectedPair(stats) {
          const transport = [...stats.values()].find((entry) => entry.type === 'transport' && entry.selectedCandidatePairId);
          const pair = transport && stats.get(transport.selectedCandidatePairId);
          const local = pair && stats.get(pair.localCandidateId);
          const remote = pair && stats.get(pair.remoteCandidateId);
          if (!pair || pair.state !== 'succeeded') throw new Error('SELECTED_PAIR_MISSING');
          if (local?.candidateType !== 'relay' || remote?.candidateType !== 'relay') throw new Error('SELECTED_PAIR_NOT_RELAY');
          // Chromium reports the client-to-TURN transport here. Candidate
          // `protocol` can still be UDP when the TURN connection uses TCP/TLS.
          if (!['udp', 'tcp', 'tls'].includes(local.relayProtocol)) throw new Error('RELAY_PROTOCOL_MISSING');
          if (mode.protocol && local.relayProtocol !== mode.protocol) throw new Error('RELAY_PROTOCOL_MISMATCH');
          return {
            localCandidateType: local.candidateType,
            remoteCandidateType: remote.candidateType,
            relayProtocol: local.relayProtocol,
            bytesSent: pair.bytesSent,
            bytesReceived: pair.bytesReceived,
          };
        }

        stage = 'MEDIA_RECEIVE';
        let receiverStats;
        let media;
        while (!closed) {
          receiverStats = await receiver.getStats();
          const inbound = [...receiverStats.values()].filter((entry) => entry.type === 'inbound-rtp');
          media = {
            audioPacketsReceived: inbound.filter((entry) => entry.kind === 'audio').reduce((sum, entry) => sum + entry.packetsReceived, 0),
            videoPacketsReceived: inbound.filter((entry) => entry.kind === 'video').reduce((sum, entry) => sum + entry.packetsReceived, 0),
            videoFramesDecoded: inbound.filter((entry) => entry.kind === 'video').reduce((sum, entry) => sum + entry.framesDecoded, 0),
          };
          if (media.audioPacketsReceived > 0 && media.videoPacketsReceived > 0 && media.videoFramesDecoded > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (closed) return;
        stage = 'SELECTED_PAIR';
        return {
          mode: mode.name,
          passed: true,
          sender: selectedPair(await sender.getStats()),
          receiver: selectedPair(receiverStats),
          dataBytesReceived: receivedBytes,
          dataBytesEchoed: echoedBytes,
          ...media,
        };
      }

      try {
        const timeout = new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('MODE_TIMEOUT')), 20_000);
        });
        return await Promise.race([exercise(), failure, timeout]);
      } catch (error) {
        // Native errors can embed TURN URLs, credentials, candidates or SDP.
        // Export only our fixed codes, never native error messages or raw stats.
        const codes = new Set([
          'PEER_CONNECTION_FAILED', 'NON_RELAY_CANDIDATE', 'ICE_CANDIDATE_REJECTED',
          'DATA_CHANNEL_FAILED', 'DATA_INTEGRITY_FAILED', 'DATA_SEND_FAILED',
          'SELECTED_PAIR_MISSING', 'SELECTED_PAIR_NOT_RELAY', 'RELAY_PROTOCOL_MISSING',
          'RELAY_PROTOCOL_MISMATCH', 'MODE_TIMEOUT',
        ]);
        return { mode: mode.name, passed: false, error: codes.has(error?.message) ? error.message : 'VERIFICATION_FAILED', stage };
      } finally {
        closed = true;
        clearTimeout(deadline);
        clearInterval(drawTimer);
        for (const peer of peers) {
          peer.onicecandidate = null;
          peer.onconnectionstatechange = null;
          peer.ondatachannel = null;
          peer.ontrack = null;
        }
        for (const channel of channels) {
          channel.onmessage = null;
          channel.onopen = null;
          channel.onerror = null;
          channel.close();
        }
        for (const peer of peers) peer.close();
        for (const track of tracks) track.stop();
        // stop() may throw if oscillator setup failed before start().
        try { oscillator?.stop(); } catch { /* Already stopped or never started. */ }
        if (audio && audio.state !== 'closed') await audio.close();
      }
    }

    // Independent pairs run together to bound this CLI check to 25 seconds,
    // including credential issuance. Credentials never leave page.evaluate.
    const results = await Promise.all(modes.map(verifyMode));
    return { passed: results.every((result) => result.passed), results };
  }).catch(() => ({ passed: false, error: 'BROWSER_VERIFICATION_FAILED' }));
  if (!report.passed) throw new Error(`TURN relay verification failed: ${JSON.stringify(report)}`);
  return report;
}
