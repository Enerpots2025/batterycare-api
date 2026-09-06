// ============================
// app-state.js
// ============================
// Purpose: replace Firestore as the storage for your web app's data
// (technicians, OEMs, jobs, etc.), while KEEPING Firebase purely for
// login (Authentication). The whole app state is stored as a single
// JSON document in Postgres — same shape as your old Firestore doc —
// so the frontend's data model does not need to change at all.
//
// Auth model:
//   - The frontend still signs users in with Firebase Authentication.
//   - After signing in, the frontend gets a Firebase ID token
//     (currentUser.getIdToken()) and sends it as:
//       Authorization: Bearer <token>
//     on every request to this API.
//   - This file verifies that token using Firebase Admin SDK (server-side),
//     so only genuinely logged-in users can read/write your data.

const express = require('express');
const admin = require('firebase-admin');
const { Pool } = require('pg');

const router = express.Router();

// ----------------------------
// Firebase Admin initialization
// ----------------------------
// Reads credentials from environment variables (NOT a committed JSON
// file — committing a service account key would leak a private key).
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    console.warn('⚠️  Missing Firebase Admin env vars (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY). /api/state will reject all requests until these are set.');
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      })
    });
    console.log('✅ Firebase Admin initialized');
  }
}

// ----------------------------
// Postgres connection
// ----------------------------
// DATABASE_URL is provided automatically by Render when you create a
// Postgres database and link it to this web service (or you can paste
// the "External Database URL" into your service's environment variables).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Ensure the table exists. This app state is stored as ONE row (id = 1)
// containing the entire app JSON blob, mirroring the old single Firestore
// document (batterycare/state).
const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
};
let tableReadyPromise = null;
const getTableReady = () => {
  if (!tableReadyPromise) {
    tableReadyPromise = ensureTable().catch(err => {
      tableReadyPromise = null; // allow retry on next request if this failed
      throw err;
    });
  }
  return tableReadyPromise;
};

// ----------------------------
// Middleware: verify Firebase ID token
// ----------------------------
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null
    };

    next();
  } catch (error) {
    console.error('❌ Firebase token verification failed:', error.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// ----------------------------
// Routes
// ----------------------------

// GET /api/state — load the whole app state (or null if nothing saved yet)
router.get('/', verifyFirebaseToken, async (req, res) => {
  try {
    await getTableReady();
    const result = await pool.query('SELECT data FROM app_state WHERE id = 1');

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    res.json({ success: true, data: result.rows[0].data });
  } catch (error) {
    console.error('❌ Error loading app state:', error);
    res.status(500).json({ success: false, error: 'Failed to load app state' });
  }
});

// PUT /api/state — save (overwrite) the whole app state
router.put('/', verifyFirebaseToken, async (req, res) => {
  try {
    const newState = req.body;

    if (!newState || typeof newState !== 'object') {
      return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    }

    await getTableReady();

    await pool.query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [newState]
    );

    res.json({ success: true, message: 'App state saved' });
  } catch (error) {
    console.error('❌ Error saving app state:', error);
    res.status(500).json({ success: false, error: 'Failed to save app state' });
  }
});

module.exports = router;
