import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element.');

// No StrictMode: its development-only double run of effects would open the MCP connection and
// each card twice, and the developer drawer is meant to show exactly the traffic that happened.
createRoot(root).render(<App />);
