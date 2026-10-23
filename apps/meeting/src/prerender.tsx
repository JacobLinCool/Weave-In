import { renderToStaticMarkup } from 'react-dom/server';
import { AboutPage } from './about';
import { LandingSurface } from './landing';

const noop = (): void => {};

/** Markup for the public pages, rendered at build time so crawlers and visitors
 * without JavaScript can read them. The client replaces it once its page loads. */
export function renderPublicPages(): { landing: string; about: string } {
  return {
    landing: renderToStaticMarkup(
      <LandingSurface
        displayName=""
        roomCode=""
        invitedRoom=""
        localStream={null}
        micEnabled
        cameraEnabled
        connecting={false}
        error={null}
        onDisplayNameChange={noop}
        onRoomCodeChange={noop}
        onPreview={noop}
        onToggleMic={noop}
        onToggleCamera={noop}
        onOpenSettings={noop}
        onCreate={noop}
        onJoin={noop}
      />,
    ),
    about: renderToStaticMarkup(<AboutPage />),
  };
}
