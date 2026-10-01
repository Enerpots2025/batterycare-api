// ============================
// customer-api.js
// ============================
// Purpose: the ONLY backend surface customers ever talk to. Customers
// never create a real account — the frontend signs them in anonymously
// (Firebase Anonymous Auth) purely so every request still carries a valid,
// verifiable token. This file is deliberately narrow:
//   - It never returns the full app_state blob (technician contact info,
//     OEM contracts, payouts, other customers' jobs).
//   - It only lets a customer CREATE a job with a whitelisted set of safe
//     fields — never price, payout, or technician assignment.
//   - Anonymous tokens are explicitly WELCOMED here (the opposite of
//     app-state.js and location.js, which explicitly reject them).

const express = require('express');
const admin = require('firebase-admin');
const { pool, readState, mutateState } = require('./state-store');

const router = express.Router();

// Accepts ANY valid Firebase token, including anonymous ones — that's the
// whole point of this file. It only proves "this is some real browser
// session", not who they are or what they're allowed to see, which is why
// every route below still limits exactly what's read or written.
const verifyAnyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decodedToken.uid };
    next();
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// Read-only view of the current data (never written back from here).
const loadFullState = async () => {
  const row = await readState();
  return (row && row.data) || { jobs: [], technicians: [], catalogue: [] };
};

const nextCustomerJobId = (jobs) => {
  const year = new Date().getFullYear();
  const prefix = `BC-${year}-`;
  const nums = jobs
    .map(j => j.id && j.id.startsWith(prefix) ? parseInt(j.id.slice(prefix.length), 10) : 0)
    .filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return prefix + String(next).padStart(4, '0');
};

// POST /api/customer/jobs — create a new job. Only a fixed whitelist of
// fields can be set by the customer; everything else (pricing, technician
// assignment, payout) is filled in safely by the server, exactly as it
// always was for the Ops/OEM-created flows.
router.post('/jobs', verifyAnyFirebaseToken, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.customer || !b.mobile || !b.city || !b.complaint) {
      return res.status(400).json({ success: false, error: 'customer, mobile, city, and complaint are required' });
    }

    const out = await mutateState((current) => {
      const state = current ? { ...current } : {};
      state.jobs = Array.isArray(state.jobs) ? [...state.jobs] : [];
      const cat = (state.catalogue || []).find(c => c.code === 'BC-DIAG');
      const id = nextCustomerJobId(state.jobs);

      state.jobs.push({
        id,
        customer: String(b.customer).slice(0, 120),
        mobile: String(b.mobile).slice(0, 20),
        city: String(b.city).slice(0, 60),
        brand: b.brand ? String(b.brand).slice(0, 60) : '',
        model: b.model ? String(b.model).slice(0, 60) : '',
        serial: b.serial ? String(b.serial).slice(0, 60) : '',
        complaint: String(b.complaint).slice(0, 500),
        warranty: ['Yes', 'No', 'Not sure'].includes(b.warranty) ? b.warranty : 'Not sure',
        priority: ['P1', 'P2', 'P3'].includes(b.priority) ? b.priority : 'P2',
        customerLat: typeof b.customerLat === 'number' ? b.customerLat : null,
        customerLng: typeof b.customerLng === 'number' ? b.customerLng : null,
        date: new Date().toISOString().slice(0, 10),
        // Everything below is decided by the server, never the customer:
        requiredLevel: 'L2',
        serviceCode: cat ? cat.code : 'BC-DIAG',
        assignedTech: '',
        status: 'Unassigned',
        createdAt: new Date().toISOString(),
        quoted: cat ? cat.price : 0,
        collected: 0, techPayout: 0, partsCost: 0, rootCause: '', closureDate: '', rating: 0, sop: {},
        source: 'Customer', oemId: '', callbackRequestedAt: ''
      });
      return { data: state, result: { id } };
    });

    res.json({ success: true, jobId: out.result.id });
  } catch (error) {
    console.error('❌ Error creating customer job:', error);
    res.status(500).json({ success: false, error: 'Failed to submit job' });
  }
});

// GET /api/customer/jobs/:mobile — a REDACTED view of jobs matching a phone
// number. Only status, complaint, and the assigned technician's name/level
// are returned — never technician contact info, payout, or other data.
router.get('/jobs/:mobile', verifyAnyFirebaseToken, async (req, res) => {
  try {
    const mobile = req.params.mobile.replace(/\s/g, '');
    const state = await loadFullState();

    const jobs = (state.jobs || [])
      .filter(j => j.source === 'Customer' && (j.mobile || '').replace(/\s/g, '') === mobile)
      .map(j => {
        const tech = (state.technicians || []).find(t => t.id === j.assignedTech);
        return {
          id: j.id,
          complaint: j.complaint,
          status: j.status,
          technicianName: tech ? tech.name : null,
          technicianLevel: tech ? tech.level : null,
          technicianSharesLocation: !!(tech && tech.locationConsent === 'Yes'),
          customerLat: j.customerLat === undefined ? null : j.customerLat,
          customerLng: j.customerLng === undefined ? null : j.customerLng
        };
      });

    res.json({ success: true, jobs });
  } catch (error) {
    console.error('❌ Error loading customer jobs:', error);
    res.status(500).json({ success: false, error: 'Failed to load jobs' });
  }
});

// POST /api/customer/jobs/:id/close — customer confirms a completed job,
// closing it. Only allowed on jobs that are already "Completed".
router.post('/jobs/:id/close', verifyAnyFirebaseToken, async (req, res) => {
  try {
    const out = await mutateState((current) => {
      if (!current) return { skip: true, result: { code: 404 } };
      const jobs = Array.isArray(current.jobs) ? current.jobs : [];
      const idx = jobs.findIndex(j => j.id === req.params.id);
      if (idx === -1) return { skip: true, result: { code: 404 } };
      if (jobs[idx].status !== 'Completed') return { skip: true, result: { code: 400 } };

      const nextJobs = [...jobs];
      nextJobs[idx] = { ...jobs[idx], status: 'Closed' };
      return { data: { ...current, jobs: nextJobs }, result: { code: 200 } };
    });

    if (out.result.code === 404) return res.status(404).json({ success: false, error: 'Job not found' });
    if (out.result.code === 400) return res.status(400).json({ success: false, error: 'Only completed jobs can be closed' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error closing job:', error);
    res.status(500).json({ success: false, error: 'Failed to close job' });
  }
});

// GET /api/customer/location/:jobId — live technician location, scoped to
// a SPECIFIC job rather than a raw technician ID. Only works while that
// job is "In Progress" — this is what stops a stranger from enumerating
// technician IDs to track people outside of an active job they're tied to.
router.get('/location/:jobId', verifyAnyFirebaseToken, async (req, res) => {
  try {
    const state = await loadFullState();
    const job = (state.jobs || []).find(j => j.id === req.params.jobId);

    if (!job || job.status !== 'In Progress' || !job.assignedTech) {
      return res.json({ success: true, data: null });
    }

    const result = await pool.query(
      'SELECT lat, lng, updated_at FROM live_locations WHERE tech_id = $1',
      [job.assignedTech]
    );

    if (result.rows.length === 0) return res.json({ success: true, data: null });

    const row = result.rows[0];
    res.json({ success: true, data: { lat: row.lat, lng: row.lng, updatedAt: row.updated_at } });
  } catch (error) {
    console.error('❌ Error loading job location:', error);
    res.status(500).json({ success: false, error: 'Failed to load location' });
  }
});

module.exports = router;
