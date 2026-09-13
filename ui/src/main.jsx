/**
 * Entry point. StrictMode stays on: every subscription in this app tears itself down for real, and
 * the double-invocation is what proves it — a dashboard that leaks an EventSource per remount ends
 * up with several streams writing into one log view.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
