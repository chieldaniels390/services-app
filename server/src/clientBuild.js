import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
export const CLIENT_DIST = path.join(CLIENT_DIR, 'dist');

function newestMtime(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(target)) newest = Math.max(newest, newestMtime(path.join(target, entry)));
  return newest;
}

/**
 * Says why the built client in client/dist can't be trusted, or returns null when it's current.
 * The server serves whatever is in dist, so an old build means old code in the browser.
 */
export function clientBuildProblem() {
  const index = path.join(CLIENT_DIST, 'index.html');
  if (!existsSync(index)) return 'client/dist is missing, so this port only serves the API.';
  const built = statSync(index).mtimeMs;
  const sources = ['src', 'public', 'index.html', 'package.json', 'vite.config.js'].map((p) => path.join(CLIENT_DIR, p));
  if (Math.max(...sources.map(newestMtime)) > built) return 'client/dist is older than the client source code.';
  const assets = path.join(CLIENT_DIST, 'assets');
  const bundles = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  if (bundles.some((f) => readFileSync(path.join(assets, f), 'utf8').includes('tile.openstreetmap.org'))) {
    return 'client/dist is an old build that still loads OpenStreetMap tiles.';
  }
  return null;
}
