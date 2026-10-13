import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { StoreProvider } from './store';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';

function Loading() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: '#555', fontFamily: 'sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 18, marginBottom: 8 }}>OPERA Cloud Demo</div>
        <div>Loading property data… / 正在加载酒店数据…</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider fallback={<Loading />}>
      <App />
    </StoreProvider>
  </React.StrictMode>,
);
