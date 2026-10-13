/** Task Sheets (doc 03 §4.6): auto-generate attendant task sheets by credits, reassign rooms, per-attendant sheets. */
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { RoomView } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, Button, Checkbox, DataTable, EmptyState, Modal, PageHeader, Select, Tabs, cx, type Column } from '../components/ui';
import { ResvStatusBadge, ServiceBadge, StatusBadge, roomNo, useLabels } from '../components/status';
import './TaskSheets.css';

const NONE = '__none';

function CreditBar({ used, max }: { used: number; max: number }) {
  const t = useT();
  const over = used > max;
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div className="ts-load">
      <div className={cx('txt', over && 'over')}>
        {used} / {max} {t('credits', '学分')}
        {over && ` · ${t('over limit', '超出上限')}`}
      </div>
      <div className="ts-bar" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used}>
        <div className={cx('ts-fill', over && 'over')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function TaskSheets() {
  const { snapshot, views, exec, recentRooms } = useStore();
  const t = useT();
  const l = useLabels();
  const [sp, setSp] = useSearchParams();
  const atts = snapshot.attendants;

  // ---- tab state (deep link ?att=HK01 or ?att=unassigned)
  const attParam = sp.get('att');
  const tab = attParam === 'unassigned' || atts.some((a) => a.id === attParam) ? (attParam as string) : 'overview';
  const [sel, setSel] = useState<string[]>([]);
  const setTab = (k: string) => {
    setSel([]);
    setSp(k === 'overview' ? {} : { att: k }, { replace: true });
  };

  // ---- generate panel
  const [picked, setPicked] = useState<string[]>(() => atts.filter((a) => a.section).map((a) => a.id));
  const [onlyDirty, setOnlyDirty] = useState(true);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // ---- reassign
  const [reassignRoom, setReassignRoom] = useState<RoomView | null>(null);
  const [reassignTo, setReassignTo] = useState<string>(NONE);
  const [bulkTo, setBulkTo] = useState<string>('');

  const credits = useMemo(() => new Map(snapshot.roomTypes.map((r) => [r.code, r.credits])), [snapshot.roomTypes]);
  const creditsOf = (v: RoomView) => credits.get(v.roomType) ?? v.credits;
  const isDone = (v: RoomView) => v.hkStatus === 'Clean' || v.hkStatus === 'Inspected';
  const taskOf = (v: RoomView) => {
    if (v.resvStatus === 'Due Out') return t('Departure', '退房');
    if (v.resvStatus === 'Stay Over' || v.resvStatus === 'Arrived' || v.resvStatus === 'Day Use') return t('Stayover', '续住');
    return t('Vacant', '空房');
  };
  const sumCredits = (rs: RoomView[]) => rs.reduce((n, v) => n + creditsOf(v), 0);

  const byAtt = useMemo(() => {
    const m = new Map<string, RoomView[]>();
    for (const v of views) {
      if (!v.attendantId) continue;
      const arr = m.get(v.attendantId) ?? [];
      arr.push(v);
      m.set(v.attendantId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
    return m;
  }, [views]);

  const unassigned = useMemo(
    () => views.filter((v) => !v.attendantId && !v.oooActive && (v.hkStatus === 'Dirty' || v.hkStatus === 'Pickup')).sort((a, b) => a.id.localeCompare(b.id)),
    [views],
  );

  const generate = async () => {
    if (!picked.length) {
      setGenErr(t('Select at least one attendant', '请至少选择一名客房员'));
      return;
    }
    setGenErr(null);
    setBusy(true);
    const r = await exec({ type: 'autoAssignTasks', attendantIds: picked, onlyDirty });
    setBusy(false);
    setWarnings(r.ok ? r.warnings : []);
    if (r.ok) setTab('overview');
  };

  const assign = async (roomIds: string[], attendantId: string | null) => {
    if (!roomIds.length) return;
    const r = await exec({ type: 'assignAttendant', roomIds, attendantId });
    if (r.ok) setSel([]);
  };

  const rowFlash = (v: RoomView) => (recentRooms[v.id] && Date.now() - recentRooms[v.id] < 2500 ? 'flash' : undefined);

  const targetOptions = [
    ...atts.map((a) => ({ value: a.id, label: a.name })),
    { value: NONE, label: t('Unassigned', '未分配') },
  ];

  // ---- room table used by attendant sheets and the Unassigned tab
  const sheetColumns: Column<RoomView>[] = [
    { key: 'no', header: '#', width: 40, render: () => null, align: 'center' },
    { key: 'room', header: t('Room', '房间'), sortValue: (v) => v.id, render: (v) => <span className="mono" style={{ fontWeight: 600 }}>{roomNo(v.id)}</span>, width: 70 },
    { key: 'type', header: t('Type', '房型'), sortValue: (v) => v.roomType, render: (v) => <span title={v.roomTypeName}>{v.roomType}</span>, width: 70 },
    { key: 'credits', header: t('Credits', '学分'), align: 'right', sortValue: (v) => creditsOf(v), render: (v) => creditsOf(v) },
    { key: 'task', header: t('Task', '任务'), sortValue: (v) => taskOf(v), render: (v) => taskOf(v) },
    { key: 'hk', header: t('HK Status', '房态'), sortValue: (v) => v.hkStatus, render: (v) => <StatusBadge status={v.hkStatus} /> },
    { key: 'resv', header: t('Resv Status', '预订状态'), sortValue: (v) => v.resvStatus, render: (v) => <ResvStatusBadge status={v.resvStatus} /> },
    {
      key: 'svc',
      header: t('Service', '服务'),
      render: (v) =>
        v.serviceStatus ? (
          <span className="row">
            <ServiceBadge service={v.serviceStatus} />
            {v.serviceStatus === 'DND' && <span className="ts-skip">{t('skip / later', '跳过 / 稍后')}</span>}
          </span>
        ) : null,
    },
    {
      key: 'done',
      header: t('Done', '完成'),
      align: 'center',
      sortValue: (v) => (isDone(v) ? 1 : 0),
      render: (v) => (isDone(v) ? <span className="ts-done" title={l.status(v.hkStatus)}>✔</span> : <span className="subtle">—</span>),
    },
    {
      key: 'act',
      header: '',
      width: 110,
      render: (v) => (
        <Button size="sm" onClick={() => { setReassignTo(v.attendantId ?? NONE); setReassignRoom(v); }}>
          {t('Reassign…', '改派…')}
        </Button>
      ),
    },
  ];
  // row index column (# = position in the sheet)
  const indexed = (rows: RoomView[]) => {
    const idx = new Map(rows.map((v, i) => [v.id, i + 1]));
    return sheetColumns.map((c) => (c.key === 'no' ? { ...c, render: (v: RoomView) => idx.get(v.id) } : c));
  };

  const renderRooms = (rows: RoomView[], empty: ReactNode) => (
    <DataTable<RoomView>
      columns={indexed(rows)}
      rows={rows}
      rowKey={(v) => v.id}
      selectable
      selected={sel}
      onSelectedChange={setSel}
      rowClassName={rowFlash}
      pageSize={100}
      empty={empty}
      toolbar={
        <>
          <span className="muted" style={{ fontSize: 12 }}>
            {t('Selected', '已选')}: {sel.length}
          </span>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>{t('Assign selected to', '批量改派给')}</span>
          <Select<string> value={bulkTo} onChange={setBulkTo} options={targetOptions} placeholder={t('Choose…', '选择…')} />
          <Button size="sm" variant="primary" disabled={!sel.length || !bulkTo} onClick={() => assign(sel, bulkTo === NONE ? null : bulkTo)}>
            {t('Assign Attendant', '分配客房员')}
          </Button>
        </>
      }
    />
  );

  // ---- overview rows
  const overviewRows = atts.map((a) => {
    const rooms = byAtt.get(a.id) ?? [];
    return { a, rooms, used: sumCredits(rooms), done: rooms.filter(isDone).length };
  });

  const activeAtt = atts.find((a) => a.id === tab);
  const activeRooms = activeAtt ? byAtt.get(activeAtt.id) ?? [] : [];

  const tabs = [
    { key: 'overview', label: t('Overview', '总览') },
    ...atts.map((a) => ({ key: a.id, label: a.name, count: (byAtt.get(a.id) ?? []).length })),
    { key: 'unassigned', label: t('Unassigned', '未分配'), count: unassigned.length },
  ];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Inventory', '房务'), to: '/inventory/housekeeping-board' }, { label: t('Housekeeping', '客房清洁') }, { label: t('Task Sheets', '任务单') }]}
        title={t('Task Sheets', '任务单')}
        sub={t('Generate attendant task sheets by credits, reassign rooms, and track progress. Done is derived from HK status.', '按学分自动生成客房员任务单、手工改派并查看进度；完成状态由房态自动派生')}
      />

      {/* Generate panel */}
      <section className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="section-title">{t('Generate', '生成任务单')}</div>
        <div className="col" style={{ gap: 12 }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{t('Attendants', '客房员')}</div>
            <div className="ts-gen-opts">
              {atts.map((a) => (
                <Checkbox
                  key={a.id}
                  checked={picked.includes(a.id)}
                  onChange={(on) => setPicked((p) => (on ? [...p, a.id] : p.filter((x) => x !== a.id)))}
                  label={`${a.name} (${a.section ?? t('Floater', '机动')})`}
                />
              ))}
            </div>
            {genErr && <div className="field-error" style={{ marginTop: 6 }}>{genErr}</div>}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{t('Rooms', '房间范围')}</div>
            <div className="ts-gen-opts">
              <label className="check">
                <input type="radio" name="ts-scope" checked={onlyDirty} onChange={() => setOnlyDirty(true)} />
                {t('Dirty & Pickup only', '仅 Dirty 与 Pickup')}
              </label>
              <label className="check">
                <input type="radio" name="ts-scope" checked={!onlyDirty} onChange={() => setOnlyDirty(false)} />
                {t('All rooms needing service', '所有需服务房')}
              </label>
            </div>
          </div>
          <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {t('Max credits per attendant', '每人学分上限')}:{' '}
              {atts
                .filter((a) => picked.includes(a.id))
                .map((a) => `${a.name} ${a.maxCredits}`)
                .join(' · ') || '—'}
            </span>
            <Button variant="primary" disabled={busy} onClick={generate}>
              {busy ? t('Generating…', '生成中…') : t('Generate Task Sheets', '生成任务单')}
            </Button>
          </div>
        </div>
      </section>

      {warnings.length > 0 && (
        <Alert kind="warning">
          <div className="ts-warn" style={{ margin: 0 }}>
            <div>{t(`${warnings.length} warning(s) from the last generation`, `上次生成有 ${warnings.length} 条提示`)}</div>
            <ul className="ts-ol">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </Alert>
      )}

      <Tabs<string> tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <DataTable<(typeof overviewRows)[number]>
          rows={overviewRows}
          rowKey={(r) => r.a.id}
          onRowClick={(r) => setTab(r.a.id)}
          initialSort={{ key: 'att', dir: 'asc' }}
          empty={<EmptyState title={t('No task sheets yet', '尚未生成任务单')} hint={t('Select attendants and click Generate Task Sheets', '选择客房员并点击「生成任务单」')} />}
          columns={[
            { key: 'att', header: t('Attendant', '客房员'), sortValue: (r) => r.a.name, render: (r) => <Button variant="link" onClick={() => setTab(r.a.id)}>{r.a.name}</Button> },
            { key: 'sec', header: t('Section', '区域'), sortValue: (r) => r.a.section ?? 'Z', render: (r) => (r.a.section ? `${t('Section', '区')} ${r.a.section}` : t('Floater', '机动')) },
            { key: 'rooms', header: t('Rooms', '房间数'), align: 'right', sortValue: (r) => r.rooms.length, render: (r) => r.rooms.length },
            { key: 'load', header: t('Credits used / max', '学分 已用 / 上限'), sortValue: (r) => r.used / Math.max(1, r.a.maxCredits), render: (r) => <CreditBar used={r.used} max={r.a.maxCredits} /> },
            { key: 'done', header: t('Done', '已完成'), align: 'right', sortValue: (r) => r.done, render: (r) => `${r.done} / ${r.rooms.length}` },
          ]}
        />
      )}

      {activeAtt && (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="ts-head">
            <div>
              <div className="title">
                {t('Task Sheet', '任务单')} · {activeAtt.name} · {activeAtt.section ? `${t('Section', '区')} ${activeAtt.section}` : t('Floater', '机动')} · {activeRooms.length} {t('rooms', '间房')} · {sumCredits(activeRooms)} / {activeAtt.maxCredits} {t('credits', '学分')}
              </div>
              <div className="meta">
                {t('Done', '已完成')}: {activeRooms.filter(isDone).length} / {activeRooms.length} · {t('done credits', '已完成学分')}: {sumCredits(activeRooms.filter(isDone))}
              </div>
            </div>
            <div className="ts-bar-wrap">
              <CreditBar used={sumCredits(activeRooms)} max={activeAtt.maxCredits} />
            </div>
          </div>
          {renderRooms(activeRooms, <EmptyState title={t('No rooms assigned', '暂无分配房间')} hint={t('Generate task sheets or reassign rooms from Unassigned', '请生成任务单，或从「未分配」改派房间')} />)}
        </section>
      )}

      {tab === 'unassigned' && (
        <>
          <Alert kind="info">
            {t(
              `${unassigned.length} room(s) need cleaning but have no attendant. Select rooms and assign them.`,
              `${unassigned.length} 间房需要清洁但尚未分配客房员，请勾选后分配`,
            )}
          </Alert>
          <div style={{ height: 12 }} />
          <section className="card" style={{ overflow: 'hidden' }}>
            {renderRooms(unassigned, <EmptyState title={t('Nothing unassigned', '没有未分配的房间')} hint={t('All Dirty and Pickup rooms have an attendant', '所有 Dirty / Pickup 房都已分配')} />)}
          </section>
        </>
      )}

      <Modal
        open={!!reassignRoom}
        title={reassignRoom ? `${t('Reassign room', '改派房间')} ${roomNo(reassignRoom.id)}` : ''}
        onClose={() => setReassignRoom(null)}
        width={380}
        footer={
          <>
            <Button onClick={() => setReassignRoom(null)}>{t('Cancel', '取消')}</Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!reassignRoom) return;
                const id = reassignRoom.id;
                setReassignRoom(null);
                await assign([id], reassignTo === NONE ? null : reassignTo);
              }}
            >
              {t('Reassign', '改派')}
            </Button>
          </>
        }
      >
        <div className="col">
          <div className="muted">{t('Current', '当前')}: {atts.find((a) => a.id === reassignRoom?.attendantId)?.name ?? t('Unassigned', '未分配')}</div>
          <Select<string> value={reassignTo} onChange={(v) => setReassignTo(v || NONE)} options={targetOptions} />
        </div>
      </Modal>
    </div>
  );
}
