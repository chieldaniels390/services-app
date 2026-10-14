import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import App from './App.jsx';
import { NotificationsProvider } from './notifications.jsx';
import { SessionProvider } from './session.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <NotificationsProvider>
          <App />
        </NotificationsProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
