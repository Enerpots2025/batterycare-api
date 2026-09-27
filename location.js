// ============================
// location.js
// ============================
// Purpose: live technician location during an active job. Kept in its
// own small table (NOT inside the big app_state JSON blob) because this
// updates every 10-15 seconds while a job is in progress — writing that
// into the whole-app JSON blob on every ping would be slow and wasteful.
//
// Auth model: same as app-state.js — Firebase ID token required on
// every request (Authorization: Bearer <token>).

const express = require('express');
const admin = require('firebase-admin');
const { Pool } = require('pg');

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// One row per technician — only ever holds their MOST RECENT position.
// We deliberately do not keep history here (no route replay feature).
const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_locations (
      tech_id TEXT PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};
let tableReadyPromise = null;
const getTableReady = () => {
  if (!tableReadyPromise) {
    tableReadyPromise = ensureTable().catch(err => {
      tableReadyPromise = null;
      throw err;
    });
  }
  return tableReadyPromise;
};

// Same Firebase token check as app-state.js. Duplicated here (rather than
// shared) to keep this file fully self-contained and easy to remove later
// if you ever rip out live tracking.
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decodedToken.uid, email: decodedToken.email || null };
    next();
  } catch (error) {
    console.error('❌ Firebase token verification failed:', error.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// POST /api/location — a technician's browser pings their current position.
// Body: { techId, lat, lng }
// Upserts — always overwrites the previous position, no history kept.
router.post('/', verifyFirebaseToken, async (req, res) => {
  try {
    const { techId, lat, lng } = req.body;

    if (!techId || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ success: false, error: 'techId, lat, and lng (numbers) are required' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, error: 'lat/lng out of valid range' });
    }

    await getTableReady();
    await pool.query(
      `INSERT INTO live_locations (tech_id, lat, lng, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tech_id) DO UPDATE SET lat = $2, lng = $3, updated_at = now()`,
      [techId, lat, lng]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error saving location ping:', error);
    res.status(500).json({ success: false, error: 'Failed to save location' });
  }
});

// GET /api/location/:techId — a customer's browser polls this to get the
// technician's latest known position. Returns null if nothing recorded yet
// (e.g. technician's tab isn't open, or job hasn't started).
router.get('/:techId', verifyFirebaseToken, async (req, res) => {
  try {
    await getTableReady();
    const result = await pool.query(
      'SELECT lat, lng, updated_at FROM live_locations WHERE tech_id = $1',
      [req.params.techId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      data: { lat: row.lat, lng: row.lng, updatedAt: row.updated_at }
    });
  } catch (error) {
    console.error('❌ Error loading location:', error);
    res.status(500).json({ success: false, error: 'Failed to load location' });
  }
});

module.exports = router;
