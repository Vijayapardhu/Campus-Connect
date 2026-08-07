import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import TermsPage from './components/TermsPage';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root to mount into.');

createRoot(root).render(
  <StrictMode>
    <TermsPage />
  </StrictMode>
);
