import { useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Alert, Button, Field, Modal, TextInput } from '../../components/ui';

/** Explains why Real UAT is unavailable on the static demo and lets the user attach to a remote Node backend. */
export default function RealUatModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { backendUrl, backendError, connectBackend } = useStore();
  const [url, setUrl] = useState(backendUrl ?? '');
  const ok = /^https?:\/\/\S+$/i.test(url.trim());
  return (
    <Modal
      open={open}
      title={t('Real UAT needs a backend', '真实 UAT 需要后端')}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t('Close', '关闭')}</Button>
          <Button variant="primary" disabled={!ok} onClick={() => connectBackend(url.trim().replace(/\/+$/, ''))}>
            {t('Connect', '连接')}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div>
          {t(
            'This page is running in the in-browser engine (static site). The real Akubela gateway cannot be called from a browser: it sends no CORS headers, and the client secret must never be placed in a static page.',
            '当前页面运行在浏览器内置引擎（静态站点）中。真实的 Akubela 网关无法从浏览器直接调用：网关没有 CORS 响应头，且客户端密钥不能放进静态页面。',
          )}
        </div>
        <div>
          {t(
            'Run the Node backend with credentials (for example in a GitHub Codespace), then enter its public URL below. The page reloads and talks to that backend.',
            '请运行带凭据的 Node 后端（例如在 GitHub Codespaces 中），然后在下方输入其公网地址。页面将重新加载并连接该后端。',
          )}
        </div>
        <div className="row-wrap">
          <a href="https://codespaces.new/liny90626/Opera-Demo" target="_blank" rel="noreferrer">{t('Open in GitHub Codespaces', '在 GitHub Codespaces 中打开')}</a>
          <a href="https://github.com/liny90626/Opera-Demo/blob/main/docs/09-akubela-integration-guide.md" target="_blank" rel="noreferrer">{t('Integration guide (docs/09)', '集成指南（docs/09）')}</a>
        </div>
        {backendError && <Alert kind="error">{t('Last connection attempt failed', '上次连接失败')}: {backendError}</Alert>}
        {backendUrl && (
          <div className="row-wrap">
            <span>{t('Connected backend', '当前后端')}: <span className="mono">{backendUrl}</span></span>
            <Button size="sm" onClick={() => connectBackend(null)}>{t('Disconnect', '断开')}</Button>
          </div>
        )}
        <Field label={t('Backend URL', '后端地址')}>
          <TextInput value={url} onChange={setUrl} placeholder="https://xxxx-5300.app.github.dev" />
        </Field>
      </div>
    </Modal>
  );
}
