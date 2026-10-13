import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3001);
const { app } = createApp({
  dataFile: process.env.DATA_FILE ?? path.join(here, '../data/state.json'),
  staticDir: path.join(here, '../../web/dist'),
});
app.listen(port, () => {
  console.log(`OPERA demo server listening on http://localhost:${port}`);
  console.log(`  UI (after "npm run build"): http://localhost:${port}/`);
  console.log(`  OHIP façade: http://localhost:${port}/hsk/v1/hotels/DEMO1/housekeepingOverview`);
});
