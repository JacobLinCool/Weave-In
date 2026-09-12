import { useEffect, useState, type ReactNode } from 'react';
import { Excalidraw, CaptureUpdateAction, MainMenu } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawStore } from './excalidraw-store';
import '@excalidraw/excalidraw/index.css';
import './whiteboard.css';

(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

export function Whiteboard({ store, onApi }: { store: ExcalidrawStore; onApi(api: ExcalidrawImperativeAPI | null): void }): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  useEffect(() => {
    onApi(api);
    if (!api) return;
    let pending = false;
    const sync = () => {
      const state = api.getAppState();
      // Let a local gesture/IME composition finish before applying peer snapshots.
      if (state.editingTextElement || state.resizingElement || state.newElement || state.selectedElementsAreBeingDragged) {
        pending = true;
        return;
      }
      pending = false;
      const next = store.snapshot();
      const current = api.getSceneElementsIncludingDeleted();
      if (next.length === current.length && next.every((element,i) => element.id === current[i]?.id && element.version === current[i]?.version && element.versionNonce === current[i]?.versionNonce)) return;
      api.updateScene({ elements: structuredClone(next), captureUpdate: CaptureUpdateAction.NEVER });
    };
    sync();
    // Peer messages arrive per element; render their bound text and shapes together.
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
    };
    const unsubscribe = store.subscribe(schedule);
    const unsubscribeChange = api.onChange(() => { if (pending) schedule(); });
    return () => { unsubscribe(); unsubscribeChange(); cancelAnimationFrame(frame); onApi(null); };
  }, [api, store, onApi]);
  return <section className="whiteboard" aria-label="Shared whiteboard">
    {error && <button className="whiteboard__error" role="alert" onClick={() => setError(null)}>{error} ×</button>}
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={{ elements:structuredClone(store.records()), appState:{ viewBackgroundColor:'#fafaf8', currentItemFontFamily:2, currentItemRoughness:0, currentItemFillStyle:'solid', currentItemStrokeWidth:1, currentItemStrokeColor:'#34453d', currentItemBackgroundColor:'#d6e8dc' } }}
      onChange={elements => {
        if (!store.update(elements)) {
          setError('This item exceeds the shared board limits or uses an unsupported media type.');
          api?.updateScene({ elements:structuredClone(store.records()), captureUpdate:CaptureUpdateAction.NEVER });
        }
      }}
      theme="light" isCollaborating
      UIOptions={{ tools:{image:false}, canvasActions:{loadScene:false,toggleTheme:false,saveToActiveFile:false} }}
      validateEmbeddable={false}
      onPaste={(data) => !data.files?.length}
    >
      <MainMenu><MainMenu.DefaultItems.SaveAsImage/><MainMenu.DefaultItems.ClearCanvas/><MainMenu.DefaultItems.Help/></MainMenu>
    </Excalidraw>
  </section>;
}
