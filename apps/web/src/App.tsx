import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import Dashboard from './pages/Dashboard';
import HousekeepingBoard from './pages/HousekeepingBoard';
import RoomGrid from './pages/RoomGrid';
import Discrepancies from './pages/Discrepancies';
import OutOfOrder from './pages/OutOfOrder';
import TaskSheets from './pages/TaskSheets';
import Arrivals from './pages/Arrivals';
import InHouse from './pages/InHouse';
import QueueRooms from './pages/QueueRooms';
import MobileAttendant from './pages/MobileAttendant';
import SyncMonitor from './pages/SyncMonitor';
import ApiConsole from './pages/ApiConsole';
import EndOfDay from './pages/EndOfDay';
import Guide from './pages/Guide';

export default function App() {
  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inventory/housekeeping-board" element={<HousekeepingBoard />} />
          <Route path="/inventory/room-grid" element={<RoomGrid />} />
          <Route path="/inventory/discrepancies" element={<Discrepancies />} />
          <Route path="/inventory/out-of-order" element={<OutOfOrder />} />
          <Route path="/inventory/task-sheets" element={<TaskSheets />} />
          <Route path="/front-desk/arrivals" element={<Arrivals />} />
          <Route path="/front-desk/in-house" element={<InHouse />} />
          <Route path="/front-desk/queue" element={<QueueRooms />} />
          <Route path="/mobile" element={<MobileAttendant />} />
          <Route path="/integration/sync-monitor" element={<SyncMonitor />} />
          <Route path="/integration/api-console" element={<ApiConsole />} />
          <Route path="/misc/end-of-day" element={<EndOfDay />} />
          <Route path="/guide" element={<Guide />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}
