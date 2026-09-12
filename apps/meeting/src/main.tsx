import '@fontsource-variable/jost/index.css';
import '@fontsource-variable/azeret-mono/index.css';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const App = lazy(async () => ({ default: (await import('./App')).App }));
const AboutPage = lazy(async () => ({ default: (await import('./about')).AboutPage }));
const root = document.querySelector('#root');
if (!root) throw new Error('The application root element is missing.');

const Page = /^\/about\/?$/u.test(window.location.pathname) ? AboutPage : App;
createRoot(root).render(
  <Suspense fallback={<main className="centered-surface" aria-busy="true"><p role="status">Loading Weave In…</p></main>}>
    <Page />
  </Suspense>,
);
