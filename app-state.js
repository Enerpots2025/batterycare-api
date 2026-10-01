// ============================
// app-state.js
// ============================
// The full app data (technicians, OEMs, jobs, catalogue, ...) stored as one
// JSON document in Postgres. Firebase is used ONLY for login; this file
// decides who is allowed in.
//
// Who may read/write the full data:
//   - Ops admins (their email is listed in opsUsers)
//   - Approved technicians (a technician record with their login's uid,
//     status not "Pending")
//   - OEM partners (an OEM record with their login's uid)
//   - Anyone real, but ONLY while no admin exists yet (first-admin setup)
// Everyone else — anonymous customers, strangers who just signed up, and
// technicians still awaiting approval — gets a 403 and never sees the data.

const express = require('express');
const admin = require('firebase-admin');
const { readState, mutateState } = require('./state-store');

const router = express.Router();

// ----------------------------
// Firebase Admin initialization (credentials come from env vars)
// ----------------------------
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
// Step 1: is this a real, valid, non-anonymous login?
// ----------------------------
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Anonymous sessions (customer portal) never reach the full data.
    if (decodedToken.firebase && decodedToken.firebase.sign_in_provider === 'anonymous') {
      return res.status(403).json({ success: false, code: 'anonymous', error: 'Anonymous accounts cannot access this endpoint' });
    }

    req.user = { uid: decodedToken.uid, email: decodedToken.email || null };
    next();
  } catch (error) {
    console.error('❌ Firebase token verification failed:', error.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// ----------------------------
// Step 2: is this login linked to an approved account?
// ----------------------------
const authorize = async (req, res, next) => {
  try {
    const row = await readState();
    const data = row ? row.data : null;
    const opsUsers = (data && data.opsUsers) || [];

    // Nothing saved yet, or no admin yet: first-admin setup window.
    if (!data || opsUsers.length === 0) {
      req.role = 'bootstrap';
      return next();
    }

    const email = (req.user.email || '').toLowerCase();
    if (opsUsers.some(e => String(e).toLowerCase() === email)) {
      req.role = 'ops';
      return next();
    }

    const tech = (data.technicians || []).find(t => t.authUid === req.user.uid);
    if (tech && tech.status !== 'Pending') {
      req.role = 'technician';
      return next();
    }

    const oem = (data.oems || []).find(o => o.authUid === req.user.uid);
    if (oem) {
      req.role = 'oem';
      return next();
    }

    return res.status(403).json({
      success: false,
      code: tech ? 'pending-approval' : 'not-linked',
      error: tech ? 'Your registration is awaiting approval' : 'This login is not linked to an account'
    });
  } catch (error) {
    console.error('❌ Authorization check failed:', error);
    res.status(500).json({ success: false, error: 'Authorization check failed' });
  }
};

// Records created by someone else (a customer submitting a job, a
// technician registering) while this browser had the app open must survive
// this browser's next save. Any job/technician on the server that this
// browser has never seen (created after the version it loaded) is kept.
const MERGE_KEYS = ['jobs', 'technicians'];
const mergeConcurrentAdditions = (clientData, serverData, baseUpdatedAt) => {
  const base = new Date(baseUpdatedAt).getTime();
  const merged = { ...clientData };
  let changed = false;

  for (const key of MERGE_KEYS) {
    const clientArr = Array.isArray(clientData[key]) ? clientData[key] : [];
    const serverArr = Array.isArray(serverData[key]) ? serverData[key] : [];
    const knownIds = new Set(clientArr.map(x => x && x.id));
    const additions = serverArr.filter(x =>
      x && x.id && !knownIds.has(x.id) && x.createdAt && new Date(x.createdAt).getTime() > base
    );
    if (additions.length) {
      merged[key] = [...clientArr, ...additions];
      changed = true;
    }
  }
  return { merged, changed };
};

// ----------------------------
// Routes
// ----------------------------

// GET /api/state — load the whole app state
router.get('/', verifyFirebaseToken, authorize, async (req, res) => {
  try {
    const row = await readState();
    if (!row) return res.json({ success: true, data: null, updatedAt: null });
    res.json({ success: true, data: row.data, updatedAt: new Date(row.updatedAt).toISOString() });
  } catch (error) {
    console.error('❌ Error loading app state:', error);
    res.status(500).json({ success: false, error: 'Failed to load app state' });
  }
});

// PUT /api/state — save the whole app state.
// Body: { data: <state>, baseUpdatedAt: <version this browser last loaded> }
router.put('/', verifyFirebaseToken, authorize, async (req, res) => {
  try {
    const clientData = req.body && req.body.data;
    const baseUpdatedAt = req.body && req.body.baseUpdatedAt;

    if (!clientData || typeof clientData !== 'object' || Array.isArray(clientData)) {
      return res.status(400).json({ success: false, error: 'Body must be { data: <object>, baseUpdatedAt }' });
    }

    const out = await mutateState((serverData, serverUpdatedAt) => {
      let next = { ...clientData };

      // Only admins may change who the admins are. Without this, any
      // approved technician could add their own email to opsUsers.
      if (req.role === 'technician' || req.role === 'oem') {
        next.opsUsers = (serverData && serverData.opsUsers) || [];
      }

      let mergedApplied = false;
      if (serverData && baseUpdatedAt && serverUpdatedAt &&
          new Date(serverUpdatedAt).getTime() > new Date(baseUpdatedAt).getTime()) {
        const { merged, changed } = mergeConcurrentAdditions(next, serverData, baseUpdatedAt);
        next = merged;
        mergedApplied = changed;
      }

      return { data: next, result: { mergedApplied, finalData: next } };
    });

    res.json({
      success: true,
      updatedAt: new Date(out.updatedAt).toISOString(),
      // Only sent back when something from someone else was folded in, so
      // the browser can show it without a manual refresh.
      merged: out.result.mergedApplied ? out.result.finalData : null
    });
  } catch (error) {
    console.error('❌ Error saving app state:', error);
    res.status(500).json({ success: false, error: 'Failed to save app state' });
  }
});

module.exports = router;
