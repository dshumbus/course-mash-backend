// Run with `npm run maintenance`, or point an external scheduler
// (Vercel Cron, GitHub Actions on a schedule, a simple crontab line)
// at this script for a guaranteed-to-run backstop, independent of
// whether the in-request sampled checks happened to fire recently.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { runMaintenance } = require('../src/services/maintenanceService');

runMaintenance()
  .then((snapshot) => {
    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Maintenance run failed:', err);
    process.exit(1);
  });
