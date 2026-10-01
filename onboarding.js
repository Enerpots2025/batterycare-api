// ============================
// onboarding.js
// ============================
// Endpoints for people who are not (yet) allowed into the full app data:
//
//   GET  /api/onboarding/status      public — only says whether the first
//                                    admin account still needs creating
//   POST /api/onboarding/technician  a newly signed-up technician submits
//                                    their registration. The SERVER creates
//                                    the record, always as "Pending", linked
//                                    to their login. Nobody can register
//                                    themselves as Active.
//   GET  /api/onboarding/me          a technician reads ONLY their own record
//                                    (so a Pending technician can see their
//                                    approval status without seeing anyone
//                                    else's data)

const express = require('express');
const admin = require('firebase-admin');
const { readState, mutateState } = require('./state-store');

const router = express.Router();

// Real (non-anonymous) login required.
const verifyRealToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    if (decoded.firebase && decoded.firebase.sign_in_provider === 'anonymous') {
      return res.status(403).json({ success: false, error: 'Anonymous accounts cannot register' });
    }
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// GET /api/onboarding/status — public. Reveals one yes/no fact only.
router.get('/status', async (req, res) => {
  try {
    const row = await readState();
    const opsUsers = (row && row.data && row.data.opsUsers) || [];
    res.json({ success: true, opsBootstrap: opsUsers.length === 0 });
  } catch (error) {
    console.error('❌ Error reading onboarding status:', error);
    res.status(500).json({ success: false, error: 'Failed to read status' });
  }
});

const nextTechnicianId = (technicians) => {
  const nums = technicians
    .map(t => {
      const m = /^TECH-(\d+)$/.exec(t && t.id ? t.id : '');
      return m ? parseInt(m[1], 10) : 0;
    });
  return 'TECH-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0');
};

const clip = (v, n) => (v === undefined || v === null ? '' : String(v).slice(0, n));

// POST /api/onboarding/technician
router.post('/technician', verifyRealToken, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.mobile || !b.city) {
      return res.status(400).json({ success: false, error: 'name, mobile, and city are required' });
    }

    const out = await mutateState((current) => {
      const data = current ? { ...current } : {};
      data.technicians = Array.isArray(data.technicians) ? [...data.technicians] : [];

      // One registration per login — a second attempt just returns the first.
      const existing = data.technicians.find(t => t.authUid === req.user.uid);
      if (existing) return { skip: true, result: { id: existing.id, alreadyRegistered: true } };

      const id = nextTechnicianId(data.technicians);
      data.technicians.push({
        id,
        name: clip(b.name, 120),
        mobile: clip(b.mobile, 20),
        email: req.user.email || clip(b.email, 120),
        city: clip(b.city, 60),
        state: clip(b.state, 60),
        level: ['L1', 'L2', 'L3', 'L4'].includes(b.level) ? b.level : 'L1',
        brands: clip(b.brands, 200),
        voltageClass: clip(b.voltageClass, 60),
        specialties: clip(b.specialties, 200),
        // Fixed by the server, never taken from the request:
        status: 'Pending',
        score: 0,
        jobsCompleted: 0,
        fvr: 0,
        payoutAccount: '',
        joinDate: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
        authUid: req.user.uid,
        locationConsent: b.locationConsent === 'Yes' ? 'Yes' : 'No'
      });
      return { data, result: { id, alreadyRegistered: false } };
    });

    res.json({ success: true, technicianId: out.result.id, alreadyRegistered: out.result.alreadyRegistered });
  } catch (error) {
    console.error('❌ Error registering technician:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// GET /api/onboarding/me — the caller's own technician record only.
router.get('/me', verifyRealToken, async (req, res) => {
  try {
    const row = await readState();
    const tech = row && row.data && (row.data.technicians || []).find(t => t.authUid === req.user.uid);
    if (!tech) return res.json({ success: true, technician: null });

    res.json({
      success: true,
      technician: {
        id: tech.id, name: tech.name, mobile: tech.mobile, email: tech.email,
        city: tech.city, state: tech.state, level: tech.level, status: tech.status,
        authUid: tech.authUid, locationConsent: tech.locationConsent
      }
    });
  } catch (error) {
    console.error('❌ Error loading own record:', error);
    res.status(500).json({ success: false, error: 'Failed to load your record' });
  }
});

module.exports = router;
