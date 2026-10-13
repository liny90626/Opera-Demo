import { useMemo, useState } from 'react';
import type { AkubelaState, Job, JobStatus } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Button, DataTable, EmptyState, Select, TextInput, type Column } from '../../components/ui';
import { roomNo } from '../../components/status';
import { JobBadge, fmtClock, fmtStamp } from './shared';

const STATUSES: JobStatus[] = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'SKIPPED'];

export default function JobsTab({ st }: { st: AkubelaState }) {
  const t = useT();
  const { akubelaCall, toast } = useStore();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [q, setQ] = useState('');
  const rows = useMemo(
    () => st.jobs.filter((j) => (!status || j.status === status) && (!q || `${j.summary} ${j.roomId ?? ''} ${j.action}`.toLowerCase().includes(q.toLowerCase()))),
    [st.jobs, status, q],
  );
  const retry = async (j: Job) => {
    const r = await akubelaCall('POST', `/jobs/${encodeURIComponent(j.id)}/retry`);
    if (r.status < 400) toast('info', t('Job re-queued', '作业已重新入队'));
  };
  const cols: Column<Job>[] = [
    { key: 'ts', header: t('Created', '创建'), sortValue: (j) => j.createdAt, render: (j) => fmtClock(j.createdAt) },
    { key: 'act', header: t('Action', '动作'), render: (j) => <code>{j.action}</code> },
    { key: 'sum', header: t('Summary', '摘要'), render: (j) => j.summary },
    { key: 'room', header: t('Room', '房间'), render: (j) => (j.roomId ? roomNo(j.roomId) : '—') },
    { key: 'ev', header: t('Event', '事件'), render: (j) => <span className="subtle">{j.eventName ?? '—'}</span> },
    { key: 'st', header: t('Status', '状态'), render: (j) => <JobBadge status={j.status} /> },
    { key: 'att', header: t('Attempts', '次数'), align: 'right', render: (j) => j.attempts },
    { key: 'next', header: t('Next retry', '下次重试'), render: (j) => (j.status === 'PENDING' || j.status === 'FAILED' ? fmtStamp(j.nextRunAt) : '—') },
    {
      key: 'err',
      header: t('Error', '错误'),
      render: (j) =>
        j.lastError ? (
          <span style={{ whiteSpace: 'normal' }}>
            <b className="mono" style={{ color: '#b3242b' }}>{j.lastError.code}</b> {j.lastError.message}
            {j.lastError.traceId && <div className="subtle mono" style={{ fontSize: 11 }}>trace {j.lastError.traceId}</div>}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'act2',
      header: '',
      render: (j) => (j.status === 'FAILED' || j.status === 'DEAD' ? <Button size="sm" onClick={() => retry(j)}>{t('Retry', '重试')}</Button> : null),
    },
  ];
  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(j) => j.id}
      pageSize={30}
      initialSort={{ key: 'ts', dir: 'desc' }}
      empty={<EmptyState title={t('No jobs', '没有作业')} hint={t('Jobs are created from PMS business events (check-in, check-out, room move, HK status…).', '作业由 PMS 业务事件（入住、退房、换房、房态…）生成。')} />}
      toolbar={
        <>
          <Select value={status} onChange={setStatus} placeholder={t('All statuses', '全部状态')} options={STATUSES.map((s) => ({ value: s, label: `${s} (${st.jobs.filter((j) => j.status === s).length})` }))} />
          <TextInput value={q} onChange={setQ} placeholder={t('Search summary / room', '搜索摘要 / 房号')} className="aku-q" />
          <span className="subtle">
            ✓ {st.stats.jobsSucceeded} · ✗ {st.stats.jobsFailed} · ↩ {st.stats.inboundApplied}
          </span>
        </>
      }
    />
  );
}
