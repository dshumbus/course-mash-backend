require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const path = require('path');
const express = require('express');
const cors = require('cors');

const voteRoutes = require('./routes/vote');
const stateRoutes = require('./routes/state');
const maintenanceRoutes = require('./routes/maintenance');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' })); // votes are tiny payloads; cap generously against abuse

app.use('/api', voteRoutes);
app.use('/api', stateRoutes);
app.use('/api', maintenanceRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serves course_mash.html (and any other static assets you drop in
// /public) at the site root, e.g. http://localhost:8787/course_mash.html
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Course Mash backend listening on :${PORT}`);
});
