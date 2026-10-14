import { createApp } from './app.js';
import { clientBuildProblem } from './clientBuild.js';
import { config } from './config.js';
import { openDb } from './db.js';

if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_SECRET) {
  console.error('TOKEN_SECRET must be set in production');
  process.exit(1);
}

if (!(config.platformFeeRate >= 0 && config.platformFeeRate < 1)) {
  console.error('PLATFORM_FEE_RATE must be a fraction between 0 and 1, e.g. 0.15 for 15%');
  process.exit(1);
}
if (!config.paystack.secretKey) {
  console.warn('PAYSTACK_SECRET_KEY is not set - customers will not be able to book until it is.');
} else if (config.paystack.secretKey.startsWith('sk_test_')) {
  console.log('Paystack is in TEST mode - no real money moves.');
}

const buildProblem = clientBuildProblem();
if (buildProblem) {
  console.warn(`\n*** ${buildProblem}\n*** Run "npm start" from the project root (it builds first), or "npm run build", then restart.\n`);
}

const db = openDb(config.dbFile);
const { server } = createApp({ db });
server.listen(config.port, () => {
  console.log(`ProNow listening on http://localhost:${config.port}`);
  if (config.appUrl !== 'http://localhost:5173') console.log(`Public URL: ${config.appUrl}`);
});
