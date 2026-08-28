// Simple in-memory database for BatteryCare
// Replace with MongoDB/PostgreSQL when scaling

const database = {
  jobs: {},
  engineers: {},
  customers: {},
  notifications: []
};

// Job Management
const saveJob = (job) => {
  database.jobs[job.id] = job;
  console.log(`💾 Saved job: ${job.id}`);
};

const getJob = (jobId) => {
  return database.jobs[jobId];
};

const updateJobStatus = (jobId, status, additionalData = {}) => {
  if (database.jobs[jobId]) {
    database.jobs[jobId].status = status;
    database.jobs[jobId].updatedAt = new Date().toISOString();
    
    // Add any additional data
    Object.keys(additionalData).forEach(key => {
      database.jobs[jobId][key] = additionalData[key];
    });
    
    console.log(`🔄 Updated job ${jobId} to status: ${status}`);
    return true;
  }
  return false;
};

const getJobsByStatus = (statusArray = null, phoneNumber = null) => {
  let jobs = Object.values(database.jobs);
  
  if (statusArray) {
    jobs = jobs.filter(job => statusArray.includes(job.status));
  }
  
  if (phoneNumber) {
    jobs = jobs.filter(job => 
      job.engineerPhone === phoneNumber || 
      job.customerPhone === phoneNumber
    );
  }
  
  return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

const getJobsForEngineer = (engineerPhone, status = null) => {
  let jobs = Object.values(database.jobs).filter(
    job => job.engineerPhone === engineerPhone
  );
  
  if (status) {
    jobs = jobs.filter(job => job.status === status);
  }
  
  return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

const closeJob = (jobId) => {
  if (database.jobs[jobId]) {
    database.jobs[jobId].closed = true;
    database.jobs[jobId].closedAt = new Date().toISOString();
    return true;
  }
  return false;
};

// Engineer Management
const saveEngineer = (engineer) => {
  database.engineers[engineer.phone] = engineer;
  console.log(`👨‍🔧 Saved engineer: ${engineer.name}`);
};

const getEngineerByPhone = (phone) => {
  return database.engineers[phone];
};

const getAllEngineers = () => {
  return Object.values(database.engineers);
};

const updateEngineerStatus = (phone, status) => {
  if (database.engineers[phone]) {
    database.engineers[phone].status = status;
    database.engineers[phone].lastOnline = new Date().toISOString();
    console.log(`👨‍🔧 Engineer ${phone.substring(0, 10)}... status: ${status}`);
    return true;
  }
  return false;
};

const updateEngineerEarnings = (phone, earnings) => {
  if (database.engineers[phone]) {
    database.engineers[phone].totalEarnings += earnings;
    database.engineers[phone].totalJobs += 1;
    return true;
  }
  return false;
};

// Customer Management
const saveCustomer = (customer) => {
  database.customers[customer.phone] = customer;
  console.log(`👤 Saved customer: ${customer.name}`);
};

const getCustomerByPhone = (phone) => {
  return database.customers[phone];
};

const getAllCustomers = () => {
  return Object.values(database.customers);
};

// Account Utility
const getAccountByPhone = (phone) => {
  return database.engineers[phone] || database.customers[phone];
};

module.exports = {
  // Jobs
  saveJob,
  getJob,
  updateJobStatus,
  getJobsByStatus,
  getJobsForEngineer,
  closeJob,
  
  // Engineers
  saveEngineer,
  getEngineerByPhone,
  getAllEngineers,
  updateEngineerStatus,
  updateEngineerEarnings,
  
  // Customers
  saveCustomer,
  getCustomerByPhone,
  getAllCustomers,
  
  // Utility
  getAccountByPhone
};
