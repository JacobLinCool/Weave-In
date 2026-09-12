async (page, origin = 'http://127.0.0.1:8796') => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const output = 'output/playwright/demo-whiteboard';
  await mkdir(output, { recursive: true });
  const browser = page.context().browser();
  const contexts = [];
  const setup = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone', 'camera'] });
    contexts.push(context);
    // This harness verifies room/tool integration with local peers, not TURN transport.
    await context.route('**/api/ice-servers', route => route.fulfill({ json: {
      ok: true, expiresAt: Date.now() + 86_400_000,
      iceServers: [{ urls: 'turn:127.0.0.1:9', username: 'test', credential: 'test' }],
    } }));
    await context.addInitScript(() => {
      localStorage.setItem('weave-in:settings', JSON.stringify({ captionsEnabled: false, languageCodes: [], mode: 'VERBATIM' }));
      // Adapter only: actual application tool callbacks run unchanged. This is not
      // evidence that an external Codex client has native WebMCP support.
      window.__demoTools = {};
      Object.defineProperty(navigator, 'modelContext', { configurable: true, value: {
        registerTool(tool) { window.__demoTools[tool.name] = tool; },
        unregisterTool(name) { delete window.__demoTools[name]; },
      } });
    });
    const p = await context.newPage();
    p.setDefaultTimeout(20_000);
    return p;
  };
  const invoke = async (p, name, args = {}) => p.evaluate(async ({ name, args }) => {
    const result = await window.__demoTools[name].execute(args);
    if (result.isError) throw new Error(JSON.stringify(result));
    return result;
  }, { name, args });
  const parse = result => JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  const board = async p => parse(await invoke(p, 'edit_whiteboard', { action: 'read' })).elements.filter(e => !e.isDeleted);
  // Poll in Node: this browser build resolves waitForFunction(async () => false)
  // immediately instead of waiting for the fulfilled boolean.
  const until = async (check, message) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(message);
  };
  const join = async (p, url, name, create = false) => {
    await p.goto(url);
    await p.getByRole('textbox', { name: 'Display name', exact: true }).fill(name);
    await p.getByRole('button', { name: create ? 'Create a room' : 'Join', exact: true }).click();
    await p.getByRole('button', { name: 'Leave meeting', exact: true }).waitFor();
  };
  const hasText = (p, text) => until(async () => (await board(p)).some(e => e.text === text), `Missing synchronized text: ${text}`);
  const capture = async (p, filename) => {
    const result = await invoke(p, 'capture_whiteboard', { format: 'png' });
    const image = result.content.find(part => part.type === 'image');
    if (!image) throw new Error('Capture did not return an image');
    await writeFile(`${output}/${filename}.png`, Buffer.from(image.data, 'base64'));
    const bounds = await p.evaluate(async image => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image.data), c => c.charCodeAt(0))], { type: image.mimeType }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width, top = canvas.height, right = -1, bottom = -1, ink = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (pixels[i + 3] > 200 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 180) {
          ink++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      return { left, top, right, bottom, ink, width: canvas.width, height: canvas.height };
    }, image);
    if (bounds.ink < 100 || bounds.left < 5 || bounds.top < 5 || bounds.right >= bounds.width - 5 || bounds.bottom >= bounds.height - 5) throw new Error(`Blank or clipped ${filename}: ${JSON.stringify(bounds)}`);
    return bounds;
  };
  try {
    const a = await setup(), b = await setup();
    await join(a, origin, 'Demo A', true);
    const url = a.url();
    await join(b, url, 'Demo B');
    await b.getByRole('tab', { name: /^Room/ }).click();
    await b.getByPlaceholder('Send a message').fill('下次會議能否接著這次的白板繼續？');
    await b.getByPlaceholder('Send a message').press('Enter');
    await until(async () => JSON.stringify(await invoke(a, 'read_meeting')).includes('下次會議能否'), 'Meeting context was not synchronized');
    await invoke(a, 'send_chat_message', { agent: 'Codex', text: '查證：白板存在參與者記憶體；加入時傳送元素，沒有伺服器持久保存。依據：apps/meeting/src/App.tsx、apps/meeting/src/excalidraw-store.ts、README.md。' });
    await b.getByTestId('chat-list').getByText(/查證：白板/).waitFor();
    if (!(await b.getByTestId('chat-list').innerText()).includes("Demo A's agent")) throw new Error('Missing agent attribution');
    if (await a.getByRole('region', { name: 'Shared whiteboard', exact: true }).count()) throw new Error('Board should initially be closed');
    await invoke(a, 'edit_whiteboard', { action: 'mermaid', source: 'flowchart TD\n A[參與者記憶體中的白板] <-->|WebRTC 即時同步| B[其他參與者記憶體]\n A -->|加入時傳送元素| C[新參與者取得白板]\n A --> D[所有人離開：無伺服器保存]' });
    await a.getByRole('region', { name: 'Shared whiteboard', exact: true }).waitFor();
    const initialCapture = await capture(a, 'current');
    await hasText(b, '新參與者取得白板');
    await b.getByRole('button', { name: 'Open shared whiteboard', exact: true }).click();
    // B draws and labels a real rectangle with pointer/keyboard UI actions.
    await b.getByRole('radio', { name: 'Rectangle', exact: true }).locator('..').click();
    const canvas = await b.locator('.excalidraw__canvas.interactive').boundingBox();
    const x = canvas.x + 330, y = canvas.y + 420;
    await b.mouse.move(x, y); await b.mouse.down();
    await b.mouse.move(x + 290, y + 85, { steps: 20 }); await b.mouse.up();
    await b.getByRole('radio', { name: 'Selection', exact: true }).locator('..').click();
    await b.mouse.dblclick(x + 145, y + 42, { delay: 100 });
    await b.locator('textarea.excalidraw-wysiwyg').fill('提案：匯出可編輯檔案');
    await b.keyboard.press('Escape');
    await hasText(a, '提案：匯出可編輯檔案');
    const before = await board(a);
    const label = before.find(e => e.text === '提案：匯出可編輯檔案');
    const human = before.find(e => e.id === label.containerId);
    if (!human || human.type !== 'rectangle' || human.width < 100) throw new Error('Human-created bound rectangle was not synchronized');
    await b.screenshot({ path: `${output}/human.png` });
    await invoke(a, 'edit_whiteboard', { action: 'edit', operations: [
      { op: 'create', id: 'proposal-title', kind: 'text', x: human.x, y: human.y - 65, text: '待實作提案' },
      { op: 'create', id: 'proposal-import', kind: 'rectangle', x: human.x + 350, y: human.y, width: 220, height: 85, text: '下次會議匯入' },
      { op: 'create', id: 'proposal-edit', kind: 'rectangle', x: human.x + 630, y: human.y, width: 220, height: 85, text: '繼續共同編輯' },
      { op: 'create', id: 'proposal-link-1', kind: 'connector', x: 0, y: 0, from: human.id, to: 'proposal-import' },
      { op: 'create', id: 'proposal-link-2', kind: 'connector', x: 0, y: 0, from: 'proposal-import', to: 'proposal-edit' },
    ] });
    await hasText(b, '繼續共同編輯');
    const after = await board(a);
    for (const element of before) {
      const retained = after.find(e => e.id === element.id);
      if (!retained || ['x', 'y', 'width', 'height', 'text', 'containerId'].some(key => retained[key] !== element[key])) throw new Error(`Prior element changed: ${element.id}`);
    }
    if (!after.some(e => e.type === 'arrow' && e.startBinding?.elementId === human.id && e.endBinding?.elementId === 'proposal-import')) throw new Error('Agent did not connect the actual human node');
    const finalCapture = await capture(a, 'final');
    await a.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
    await capture(a, 'reopened');
    const late = await setup(); await join(late, url, 'Demo late');
    await hasText(late, '繼續共同編輯');
    await until(async () => (await board(late)).length === after.length, 'Late participant did not receive the full board');
    const lateBoard = await board(late);
    if (lateBoard.length !== after.length) {
      await writeFile(`${output}/sync-debug.json`, JSON.stringify({ after, a: await board(a), b: await board(b), late: lateBoard }, null, 2));
      throw new Error(`Late participant elements: expected ${after.length}, got ${lateBoard.length}`);
    }
    for (const p of [a, b, late]) await p.getByRole('button', { name: 'Leave meeting', exact: true }).click();
    // Fresh context: closing an editor alone does not discard in-memory room state.
    const returning = await setup(); await join(returning, url, 'Demo return');
    if ((await board(returning)).length) throw new Error('Unexpected board in fresh empty-room session');
    await returning.getByRole('button', { name: 'Leave meeting', exact: true }).click();
    const result = { meetingRead: true, attributedPublicPost: true, closedBoardAutoOpen: true, humanRectangle: true, existingElementsPreserved: true, agentConnectedHumanNode: true, peerSync: true, lateJoinSync: true, emptyRoomFreshBrowserHasNoBoard: true, captureAutoReopen: true, initialCapture, finalCapture, nativeCodexBridge: 'not tested; registration adapter', provider: 'no AI calls', relay: 'mocked ICE provisioning; real local WebRTC' };
    await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
    return result;
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
}
