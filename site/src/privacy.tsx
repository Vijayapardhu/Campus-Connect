import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PrivacyPage from './components/PrivacyPage';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root to mount into.');

createRoot(root).render(
  <StrictMode>
    <PrivacyPage />
  </StrictMode>
);
