// ============================
// SIMPLE IN-MEMORY DATABASE
// ============================
// ⚠️ IMPORTANT: This stores everything in plain JavaScript variables.
// All data (jobs, engineers, customers) is LOST whenever the server
// restarts or redeploys. This is fine for testing/demos, but for real
// production use you should replace this with a real database
// (e.g. AWS DynamoDB, RDS/Postgres, MongoDB Atlas, etc.).

// ---- In-memory "tables" ----
const jobs = new Map();       // key: jobId      -> job object
const engineers = new Map();  // key: phone      -> engineer object
const customers = new Map();  // key: phone      -> customer object

// ============================
// JOBS
// ============================

// Save a brand-new job (or overwrite one with the same id)
const saveJob = (job) => {
  if (!job || !job.id) {
    throw new Error('saveJob requires a job object with an "id" field');
  }
  jobs.set(job.id, { ...job });
  return jobs.get(job.id);
};

// Get a single job by its id
const getJob = (jobId) => {
  return jobs.get(jobId) || null;
};

// Update a job's status, and optionally merge in extra fields
// (e.g. updateJobStatus('JOB123', 'accepted', { acceptedBy: '91999...' }))
const updateJobStatus = (jobId, status, extraFields = {}) => {
  const job = jobs.get(jobId);
  if (!job) return null;

  const updatedJob = {
    ...job,
    ...extraFields,
    status,
    updatedAt: new Date().toISOString()
  };

  jobs.set(jobId, updatedJob);
  return updatedJob;
};

// Mark a job as fully closed/archived (kept in the store, but flagged)
const closeJob = (jobId) => {
  const job = jobs.get(jobId);
  if (!job) return null;

  const closedJob = {
    ...job,
    status: 'closed',
    closedAt: new Date().toISOString()
  };

  jobs.set(jobId, closedJob);
  return closedJob;
};

// Get jobs matching a status (or array of statuses), optionally
// filtered down to jobs belonging to a specific phone number
// (matches either the engineer or the customer on the job).
//
// Usage patterns seen in index.js:
//   getJobsByStatus(['pending_engineer_response', 'accepted'])   -> all matching jobs
//   getJobsByStatus(['completed'])                               -> all completed jobs
//   getJobsByStatus(null, phone)                                 -> all jobs for that phone, any status
const getJobsByStatus = (statusFilter = null, phone = null) => {
  let results = Array.from(jobs.values());

  // Filter by status (supports single string, array, or null = "any status")
  if (statusFilter) {
    const statusList = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
    results = results.filter(job => statusList.includes(job.status));
  }

  // Filter by phone (matches engineer or customer on the job)
  if (phone) {
    results = results.filter(job =>
      job.engineerPhone === phone ||
      job.customerPhone === phone ||
      job.acceptedBy === phone
    );
  }

  // Most recent first
  return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

// ============================
// ENGINEERS
// ============================

// Save a brand-new engineer (or overwrite one with the same phone)
const saveEngineer = (engineer) => {
  if (!engineer || !engineer.phone) {
    throw new Error('saveEngineer requires an engineer object with a "phone" field');
  }
  engineers.set(engineer.phone, { ...engineer });
  return engineers.get(engineer.phone);
};

// Get a single engineer by phone number
const getEngineerByPhone = (phone) => {
  return engineers.get(phone) || null;
};

// Get every engineer in the system
const getAllEngineers = () => {
  return Array.from(engineers.values());
};

// Update an engineer's status (e.g. 'available', 'offline', 'on_job')
const updateEngineerStatus = (phone, status) => {
  const engineer = engineers.get(phone);
  if (!engineer) return null;

  const updatedEngineer = {
    ...engineer,
    status,
    updatedAt: new Date().toISOString()
  };

  engineers.set(phone, updatedEngineer);
  return updatedEngineer;
};

// Add to an engineer's running total earnings and job count
const updateEngineerEarnings = (phone, amount) => {
  const engineer = engineers.get(phone);
  if (!engineer) return null;

  const numericAmount = parseInt(String(amount).replace(/[^0-9]/g, ''), 10) || 0;

  const updatedEngineer = {
    ...engineer,
    totalEarnings: (engineer.totalEarnings || 0) + numericAmount,
    totalJobs: (engineer.totalJobs || 0) + 1,
    updatedAt: new Date().toISOString()
  };

  engineers.set(phone, updatedEngineer);
  return updatedEngineer;
};

// Get all jobs associated with a given engineer, optionally filtered by status
// (e.g. getJobsForEngineer(phone, 'pending_engineer_response'))
const getJobsForEngineer = (phone, status = null) => {
  let results = Array.from(jobs.values()).filter(job => job.engineerPhone === phone);

  if (status) {
    results = results.filter(job => job.status === status);
  }

  // Most recent first, so callers can safely do pendingJobs[0] for "latest"
  return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

// ============================
// CUSTOMERS
// ============================

// Save a brand-new customer (or overwrite one with the same phone)
const saveCustomer = (customer) => {
  if (!customer || !customer.phone) {
    throw new Error('saveCustomer requires a customer object with a "phone" field');
  }
  customers.set(customer.phone, { ...customer });
  return customers.get(customer.phone);
};

// Get a single customer by phone number
const getCustomerByPhone = (phone) => {
  return customers.get(phone) || null;
};

// ============================
// GENERIC ACCOUNT LOOKUP
// ============================

// Look up whichever account type (engineer or customer) matches this phone.
// Returns { type: 'engineer' | 'customer', account: {...} } or null.
const getAccountByPhone = (phone) => {
  const engineer = engineers.get(phone);
  if (engineer) {
    return { type: 'engineer', account: engineer };
  }

  const customer = customers.get(phone);
  if (customer) {
    return { type: 'customer', account: customer };
  }

  return null;
};

module.exports = {
  saveJob,
  getJob,
  updateJobStatus,
  closeJob,
  getJobsByStatus,
  saveEngineer,
  getEngineerByPhone,
  getAllEngineers,
  updateEngineerStatus,
  updateEngineerEarnings,
  getJobsForEngineer,
  saveCustomer,
  getCustomerByPhone,
  getAccountByPhone
};
