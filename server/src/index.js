import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';

if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_SECRET) {
  console.error('TOKEN_SECRET must be set in production');
  process.exit(1);
}

const db = openDb(config.dbFile);
const { server } = createApp({ db });
server.listen(config.port, () => {
  console.log(`Services API listening on http://localhost:${config.port}`);
});
