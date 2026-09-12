import '@fontsource-variable/jost/index.css';
import '@fontsource-variable/azeret-mono/index.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const root = document.querySelector('#root');
if (!root) throw new Error('The application root element is missing.');

createRoot(root).render(<App />);
