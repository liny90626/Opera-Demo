import { useMemo, useState } from 'react';
import type { AkubelaState, ApiCallLog } from '@opera-demo/core';
import { useT } from '../../i18n';
import { Checkbox, DataTable, EmptyState, Select, TextInput, cx, type Column } from '../../components/ui';
import { fmtClock } from './shared';

export default function LogTab({ st }: { st: AkubelaState }) {
  const t = useT();
  const [dir, setDir] = useState<'' | 'OUT' | 'IN'>('');
  const [errOnly, setErrOnly] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => st.apiLog.filter((l) => (!dir || l.direction === dir) && (!errOnly || !l.ok) && (!q || l.command.includes(q))), [st.apiLog, dir, errOnly, q]);
  const cols: Column<ApiCallLog>[] = [
    { key: 'ts', header: t('Time', '时间'), sortValue: (l) => l.ts, render: (l) => fmtClock(l.ts) },
    { key: 'dir', header: t('Dir', '方向'), render: (l) => <span className={cx('badge', l.direction === 'OUT' ? 'info' : 'neutral')}>{l.direction}</span> },
    { key: 'cmd', header: t('Command', '命令'), render: (l) => <code>{l.command}</code> },
    {
      key: 'param',
      header: t('Param (redacted)', '参数（已脱敏）'),
      render: (l) =>
        open[l.id] ? (
          <pre className="aku-json" onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [l.id]: false })); }}>{JSON.stringify(l.param, null, 2)}</pre>
        ) : (
          <button type="button" className="btn btn-link btn-sm" onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [l.id]: true })); }}>
            <span className="mono aku-trunc">{JSON.stringify(l.param)}</span>
          </button>
        ),
    },
    {
      key: 'res',
      header: t('Result', '结果'),
      render: (l) => (
        <span title={l.message}>
          <span className={cx('badge', l.ok ? 'ok' : 'err')}>{l.ok ? 'OK' : l.code ?? 'ERR'}</span>
          {!l.ok && l.message && <div className="subtle" style={{ fontSize: 11, whiteSpace: 'normal', maxWidth: 240 }}>{l.message}</div>}
        </span>
      ),
    },
    { key: 'ms', header: 'ms', align: 'right', sortValue: (l) => l.durationMs, render: (l) => l.durationMs },
    { key: 'tr', header: 'trace_id', render: (l) => <span className="mono subtle" style={{ fontSize: 11 }}>{l.traceId ?? '—'}</span> },
  ];
  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(l) => l.id}
      pageSize={40}
      empty={<EmptyState title={t('No API calls logged', '暂无 API 调用记录')} />}
      toolbar={
        <>
          <Select value={dir} onChange={setDir} placeholder={t('All directions', '全部方向')} options={[{ value: 'OUT', label: 'OUT (PMS → GRMS)' }, { value: 'IN', label: 'IN (poll / read)' }]} />
          <Checkbox checked={errOnly} onChange={setErrOnly} label={t('Errors only', '仅错误')} />
          <TextInput value={q} onChange={setQ} placeholder={t('Command', '命令')} className="aku-q" />
          <span className="subtle">{rows.length}/{st.apiLog.length}</span>
        </>
      }
    />
  );
}
