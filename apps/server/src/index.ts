import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Tiny .env loader (repo root); existing environment variables win. No dependency needed. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(here, '../../../.env'));

const port = Number(process.env.PORT ?? 3001);
const { app, akubela, dispose } = createApp({
  dataFile: process.env.DATA_FILE ?? path.join(here, '../data/state.json'),
  staticDir: path.join(here, '../../web/dist'),
  akubela: { autoStart: true },
});
const server = app.listen(port, () => {
  const s = akubela.state();
  console.log(`OPERA demo server listening on http://localhost:${port}`);
  console.log(`  UI (after "npm run build"): http://localhost:${port}/`);
  console.log(`  OHIP façade: http://localhost:${port}/hsk/v1/hotels/DEMO1/housekeepingOverview`);
  console.log(`  Akubela GRMS integration: mode=${s.mode}${s.baseUrl ? ` base=${s.baseUrl}` : ''}`);
});
const shutdown = () => {
  dispose();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('close', dispose);
