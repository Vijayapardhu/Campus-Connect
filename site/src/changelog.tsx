import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ChangelogPage from './components/ChangelogPage';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root to mount into.');

createRoot(root).render(
  <StrictMode>
    <ChangelogPage />
  </StrictMode>
);
