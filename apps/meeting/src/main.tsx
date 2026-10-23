import '@fontsource-variable/jost/index.css';
import '@fontsource-variable/azeret-mono/index.css';
import { createRoot } from 'react-dom/client';
import './style.css';

const root = document.querySelector('#root');
if (!root) throw new Error('The application root element is missing.');

const page = /^\/about\/?$/u.test(window.location.pathname)
  ? import('./about').then((module) => module.AboutPage)
  : import('./App').then((module) => module.App);
// The built HTML carries prerendered public markup; keep it until the page can replace it.
void page.then((Page) => createRoot(root).render(<Page />));
