/** Single source of truth for navigation (mega menu, side nav, breadcrumbs). */
export interface NavItem {
  path: string;
  en: string;
  zh: string;
}
export interface NavMenu {
  key: string;
  en: string;
  zh: string;
  groups: { en: string; zh: string; items: NavItem[] }[];
}

export const NAV: NavMenu[] = [
  {
    key: 'front-desk',
    en: 'Front Desk',
    zh: '前台',
    groups: [
      {
        en: 'Workspace',
        zh: '工作区',
        items: [
          { path: '/front-desk/arrivals', en: 'Arrivals', zh: '预抵 / 入住' },
          { path: '/front-desk/in-house', en: 'In House', zh: '在住 / 退房 / 换房' },
          { path: '/front-desk/queue', en: 'Queue Rooms', zh: '排队房' },
        ],
      },
    ],
  },
  {
    key: 'inventory',
    en: 'Inventory',
    zh: '房务',
    groups: [
      {
        en: 'Room Management',
        zh: '房间管理',
        items: [
          { path: '/inventory/housekeeping-board', en: 'Housekeeping Board', zh: '房务看板' },
          { path: '/inventory/room-grid', en: 'Room Status Grid', zh: '楼层房态图' },
          { path: '/inventory/discrepancies', en: 'Room Discrepancies', zh: '房态差异' },
          { path: '/inventory/out-of-order', en: 'Out of Order / Service', zh: '维修 / 停用房' },
        ],
      },
      {
        en: 'Housekeeping',
        zh: '客房清洁',
        items: [
          { path: '/inventory/task-sheets', en: 'Task Sheets', zh: '任务单' },
          { path: '/mobile', en: 'Room Attendant Mobile', zh: '客房员移动端' },
        ],
      },
    ],
  },
  {
    key: 'integration',
    en: 'Integration (OHIP)',
    zh: '集成 (OHIP)',
    groups: [
      {
        en: 'Room Status Sync',
        zh: '房态同步',
        items: [
          { path: '/integration/sync-monitor', en: 'Sync Monitor', zh: '同步监控' },
          { path: '/integration/api-console', en: 'API Console', zh: 'API 控制台' },
        ],
      },
      {
        en: 'Guest Room Management (GRMS)',
        zh: '客控系统 (GRMS)',
        items: [{ path: '/integration/akubela', en: 'Akubela GRMS', zh: 'Akubela 客控云' }],
      },
    ],
  },
  {
    key: 'misc',
    en: 'Miscellaneous',
    zh: '其他',
    groups: [
      {
        en: 'End of Day',
        zh: '日结',
        items: [{ path: '/misc/end-of-day', en: 'End of Day & Settings', zh: '夜审与参数' }],
      },
      {
        en: 'Help',
        zh: '帮助',
        items: [{ path: '/guide', en: 'Demo Guide', zh: '演示指南' }],
      },
    ],
  },
];

export const ALL_NAV_ITEMS: (NavItem & { menu: NavMenu })[] = NAV.flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => ({ ...i, menu: m }))));
