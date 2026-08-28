require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

// Import our simple in-memory database
const {
  saveJob,
  getJob,
  updateJobStatus,
  updateEngineerStatus,
  getAllEngineers,
  getEngineerByPhone,
  getJobsForEngineer,
  saveCustomer,
  getCustomerByPhone,
  getJobsByStatus,
  closeJob,
  getAccountByPhone
} = require('./memory-db');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================
// CONFIGURATION
// ============================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'batterycare_verify_123';
const API_KEY = process.env.API_KEY || 'batterycare_api_key_456';

// WhatsApp API Configuration
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

// Application Configuration
const COMPANY_NAME = 'BatteryCare';
const SUPPORT_PHONE = '+911234567890';  // Your support number
const ADMIN_PHONES = process.env.ADMIN_PHONES ? process.env.ADMIN_PHONES.split(',') : [];

// ============================
// MIDDLEWARE: API Key Authentication
// ============================
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  // Skip authentication for webhook verification
  if (req.path === '/webhook' && req.method === 'GET') {
    return next();
  }
  
  if (!apiKey || apiKey !== API_KEY) {
    console.warn('❌ Unauthorized API access attempt');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid API Key'
    });
  }
  
  next();
};

app.use(authenticateApiKey);

// ============================
// UTILITY FUNCTIONS
// ============================
const formatPhoneNumber = (phone) => {
  if (!phone) return null;
  
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // Add India country code if missing
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  
  // Ensure it starts with country code
  if (!cleaned.startsWith('91')) {
    // If it's a full international number, keep as is
    if (cleaned.length >= 10) {
      return cleaned;
    }
    cleaned = '91' + cleaned;
  }
  
  return cleaned;
};

// ============================
// 1. WHATSAPP API SEND FUNCTION
// ============================
const sendWhatsAppTemplate = async (phoneNumber, templateName, variables, languageCode = 'en') => {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    if (!formattedPhone) {
      throw new Error('Invalid phone number format');
    }

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formattedPhone,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: languageCode
        },
        components: variables.length > 0 ? [{
          type: "body",
          parameters: variables.map(v => ({
            type: "text",
            text: String(v)
          }))
        }] : []
      }
    };

    console.log(`📤 Sending WhatsApp (${templateName}) to ${formattedPhone.substring(0, 10)}...`);

    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });

    console.log(`✅ Message ${templateName} sent to ${formattedPhone.substring(0, 10)}`, response.data?.messages?.[0]?.id);

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      timestamp: new Date().toISOString(),
      recipient: formattedPhone.substring(0, 10) + '...'
    };

  } catch (error) {
    console.error(`❌ Error sending ${templateName} to ${phoneNumber}:`, error.response?.data || error.message);
    
    // Detailed error analysis
    let errorMessage = 'Unable to send message';
    let errorCode = 'UNKNOWN_ERROR';
    
    if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message;
      errorCode = error.response.data.error.code || errorCode;
    } else if (error.code === 'ECONNREFUSED') {
      errorMessage = 'WhatsApp API service unavailable';
      errorCode = 'API_UNAVAILABLE';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Request timeout';
      errorCode = 'TIMEOUT';
    }
    
    return {
      success: false,
      error: errorMessage,
      errorCode: errorCode,
      timestamp: new Date().toISOString()
    };
  }
};

// ============================
// 2. SEND TEXT MESSAGE (Reply to user)
// ============================
const sendWhatsAppText = async (phoneNumber, textMessage) => {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    if (!formattedPhone) {
      throw new Error('Invalid phone number format');
    }

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formattedPhone,
      type: "text",
      text: {
        body: textMessage
      }
    };

    console.log(`💬 Sending text reply to ${formattedPhone.substring(0, 10)}...`);

    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Error sending text message:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message
    };
  }
};

// ============================
// 3. NOTIFICATION ENDPOINTS
// ============================
// 3.1 Job Alert to Engineer
app.post('/api/notify/job-alert', async (req, res) => {
  try {
    const { engineerPhone, location, distance, jobType, payout, jobId } = req.body;

    // Validate required fields
    if (!engineerPhone || !location || !jobType || !jobId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: engineerPhone, location, jobType, jobId'
      });
    }

    // Save job in database
    const job = {
      id: jobId,
      engineerPhone: formatPhoneNumber(engineerPhone),
      location,
      distance: distance || '1',
      jobType,
      payout: payout || '₹400',
      status: 'pending_engineer_response',
      createdAt: new Date().toISOString()
    };
    
    saveJob(job);
    
    // Update engineer status
    updateEngineerStatus(formatPhoneNumber(engineerPhone), 'job_pending');

    // Send WhatsApp notification
    const result = await sendWhatsAppTemplate(
      engineerPhone,
      'engineer_job_alert_v1',
      [location, distance || '1', jobType, payout || '₹400', jobId]
    );

    res.json({
      ...result,
      jobId: jobId,
      message: 'Job alert sent to engineer'
    });

  } catch (error) {
    console.error('Error in job-alert:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// 3.2 Engineer Assigned to Customer
app.post('/api/notify/engineer-assigned', async (req, res) => {
  try {
    const { customerPhone, engineerName, engineerRating, eta, distance, engineerContact, orderId } = req.body;

    if (!customerPhone || !engineerName || !orderId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Update job status
    updateJobStatus(orderId, 'engineer_assigned', {
      engineerName,
      engineerRating: engineerRating || '4.5',
      eta: eta || '30',
      assignedAt: new Date().toISOString()
    });

    const result = await sendWhatsAppTemplate(
      customerPhone,
      'customer_engineer_assigned_v1',
      [engineerName, engineerRating || '4.5', eta || '30', distance || '2', engineerContact || SUPPORT_PHONE, orderId]
    );

    res.json({
      ...result,
      orderId: orderId,
      message: 'Customer notified about engineer assignment'
    });

  } catch (error) {
    console.error('Error in engineer-assigned:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// 3.3 Job Completed & Invoice
app.post('/api/notify/job-completed', async (req, res) => {
  try {
    const { customerPhone, orderId, serviceType, amount, engineerName } = req.body;

    if (!customerPhone || !orderId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Update job as completed
    updateJobStatus(orderId, 'completed', {
      completedAt: new Date().toISOString(),
      amount
    });

    const result = await sendWhatsAppTemplate(
      customerPhone,
      'job_completion_invoice_v1',
      [orderId, serviceType || 'Battery Service', amount, engineerName || `${COMPANY_NAME} Engineer`]
    );

    res.json({
      ...result,
      orderId: orderId,
      message: 'Job completion notification sent'
    });

  } catch (error) {
    console.error('Error in job-completed:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// 3.4 Payment Request to Customer
app.post('/api/notify/payment-request', async (req, res) => {
  try {
    const { customerPhone, orderId, serviceType, amount } = req.body;

    if (!customerPhone || !orderId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Update job status to payment pending
    updateJobStatus(orderId, 'payment_pending');

    const result = await sendWhatsAppTemplate(
      customerPhone,
      'customer_payment_request_v1',
      [orderId, serviceType || 'Battery Service', amount]
    );

    res.json({
      ...result,
      orderId: orderId,
      message: 'Payment request sent to customer'
    });

  } catch (error) {
    console.error('Error in payment-request:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// 3.5 Engineer Payment Confirmed
app.post('/api/notify/engineer-payment', async (req, res) => {
  try {
    const { engineerPhone, orderId, amount, upiId, weeklyTotal } = req.body;

    if (!engineerPhone || !orderId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const result = await sendWhatsAppTemplate(
      engineerPhone,
      'engineer_payment_received_v1',
      [orderId, String(amount).replace('₹', ''), upiId || 'xxxx@bank', weeklyTotal || '0']
    );

    res.json({
      ...result,
      orderId: orderId,
      message: 'Payment confirmation sent to engineer'
    });

  } catch (error) {
    console.error('Error in engineer-payment:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================
// 4. WEBHOOK FOR WHATSAPP REPLIES
// ============================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`🔧 Webhook verification attempt: mode=${mode}, token=${token}`);

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Webhook verification failed');
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  console.log('📨 Incoming WhatsApp webhook event');
  
  try {
    const body = req.body;

    // Verify webhook structure
    if (!body.object || !body.entry || body.entry.length === 0) {
      console.log('❌ Invalid webhook structure');
      return res.sendStatus(400);
    }

    const entry = body.entry[0];
    
    // Skip if no changes
    if (!entry.changes || entry.changes.length === 0) {
      return res.sendStatus(200);
    }

    const change = entry.changes[0];
    const value = change.value;

    // Handle different webhook events
    if (value.messages && value.messages.length > 0) {
      // Handle incoming message
      await handleIncomingMessage(value.messages[0]);
    } else if (value.statuses && value.statuses.length > 0) {
      // Handle message status (delivered, read, etc.)
      console.log('📬 Message status update:', value.statuses[0]);
    } else {
      console.log('⚠️ Unknown webhook event:', value);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.sendStatus(200); // Still return 200 to WhatsApp
  }
});

// ============================
// 5. WHATSAPP REPLY HANDLING
// ============================
const handleIncomingMessage = async (message) => {
  const from = message.from;
  const text = message.text?.body || '';
  const messageId = message.id;
  
  console.log(`📱 From: ${from.substring(0, 10)}..., Message: "${text.substring(0, 50)}..."`);

  // Normalize response (uppercase, trim)
  const response = text.trim().toUpperCase();
  const formattedFrom = formatPhoneNumber(from);
  
  // Check if sender is a registered engineer
  const engineer = getEngineerByPhone(formattedFrom);
  
  // Check if sender is a registered customer
  const customer = getCustomerByPhone(formattedFrom);
  
  // Determine account type
  const accountType = engineer ? 'engineer' : customer ? 'customer' : 'unknown';
  
  console.log(`👤 Account type: ${accountType}`);
  
  // Handle common commands
  if (response === 'HELP' || response === 'HELP ME') {
    await sendHelpMessage(formattedFrom, accountType);
    return;
  }
  
  if (response === 'STATUS') {
    await sendJobStatus(formattedFrom, accountType);
    return;
  }
  
  if (response === 'BALANCE' || response === 'EARNINGS') {
    await sendEarningsStatus(formattedFrom, engineer);
    return;
  }
  
  // Handle engineer-specific responses
  if (engineer && response.startsWith('YES')) {
    await handleEngineerAcceptance(formattedFrom, response, engineer);
    return;
  }
  
  if (engineer && (response.startsWith('NO') || response.startsWith('REJECT'))) {
    await handleEngineerRejection(formattedFrom, response, engineer);
    return;
  }
  
  if (engineer && response === 'ONLINE') {
    await setEngineerOnline(formattedFrom, engineer);
    return;
  }
  
  if (engineer && response === 'OFFLINE') {
    await setEngineerOffline(formattedFrom, engineer);
    return;
  }
  
  // Handle customer-specific responses
  if (customer && response.startsWith('CANCEL')) {
    await handleCustomerCancellation(formattedFrom, response, customer);
    return;
  }
  
  if (customer && response.startsWith('PAID')) {
    await handlePaymentConfirmation(formattedFrom, response, customer);
    return;
  }
  
  // Default response for unhandled messages
  await sendDefaultResponse(formattedFrom, accountType);
};

// ============================
// 6. REPLY HANDLER FUNCTIONS
// ============================
const sendHelpMessage = async (phone, accountType) => {
  let helpText = '';
  
  if (accountType === 'engineer') {
    helpText = `🔋 ${COMPANY_NAME} Engineer Commands:\n\n` +
               `YES JOB123 - Accept a job\n` +
               `NO - Reject current job\n` +
               `ONLINE - Go online for jobs\n` +
               `OFFLINE - Go offline\n` +
               `STATUS - Check job status\n` +
               `BALANCE - View your earnings\n` +
               `HELP - Show this help\n\n` +
               `Need help? Call ${SUPPORT_PHONE}`;
  } else if (accountType === 'customer') {
    helpText = `🔋 ${COMPANY_NAME} Customer Help:\n\n` +
               `STATUS ORD123 - Check your job status\n` +
               `CANCEL ORD123 - Cancel a job\n` +
               `PAID ORD123 - Confirm payment\n` +
               `HELP - Show this help\n\n` +
               `Support: ${SUPPORT_PHONE}`;
  } else {
    helpText = `🔋 Welcome to ${COMPANY_NAME}!\n\n` +
               `You can:\n` +
               `1. Log a complaint at our website\n` +
               `2. Track your service status\n` +
               `3. Get help from our support team\n\n` +
               `Visit: [Your Website URL]\n` +
               `Call: ${SUPPORT_PHONE}`;
  }
  
  await sendWhatsAppText(phone, helpText);
  console.log(`📖 Sent help message to ${phone.substring(0, 10)}...`);
};

const handleEngineerAcceptance = async (phone, response, engineer) => {
  // Extract job ID from response (e.g., "YES JOB123" or "YESJOB123")
  const jobMatch = response.match(/YES\s*([A-Z0-9]+)/i);
  const jobId = jobMatch ? jobMatch[1] : null;
  
  if (!jobId) {
    // Get pending jobs for this engineer
    const pendingJobs = getJobsForEngineer(phone, 'pending_engineer_response');
    
    if (pendingJobs.length === 0) {
      await sendWhatsAppText(phone, '❌ No pending jobs found. Please specify job ID: YES JOB123');
      return;
    }
    
    // Accept the most recent pending job
    const latestJob = pendingJobs[0];
    jobId = latestJob.id;
  }
  
  // Update job status
  const job = getJob(jobId);
  if (!job) {
    await sendWhatsAppText(phone, `❌ Job ${jobId} not found or already assigned`);
    return;
  }
  
  if (job.status !== 'pending_engineer_response') {
    await sendWhatsAppText(phone, `ℹ️ Job ${jobId} is no longer available for acceptance`);
    return;
  }
  
  // Accept the job
  updateJobStatus(jobId, 'accepted', {
    acceptedBy: phone,
    acceptedAt: new Date().toISOString(),
    engineerName: engineer.name || 'Engineer'
  });
  
  updateEngineerStatus(phone, 'on_job');
  
  // Notify admin/customer
  await sendWhatsAppText(phone, `✅ Job ${jobId} accepted! Please proceed to: ${job.location}`);
  console.log(`✅ Engineer ${phone.substring(0, 10)}... accepted job ${jobId}`);
  
  // Notify admin
  if (ADMIN_PHONES.length > 0) {
    for (const adminPhone of ADMIN_PHONES) {
      await sendWhatsAppText(adminPhone, `👨‍🔧 Engineer ${engineer.name || phone} accepted job ${jobId} at ${job.location}`);
    }
  }
};

const handleEngineerRejection = async (phone, response, engineer) => {
  // Similar to acceptance but with rejection
  await sendWhatsAppText(phone, `ℹ️ Job rejected. You'll receive new job alerts shortly.`);
  updateEngineerStatus(phone, 'available');
  
  // Notify admin about rejection if needed
  if (ADMIN_PHONES.length > 0) {
    await sendWhatsAppText(ADMIN_PHONES[0], `⚠️ Engineer ${engineer.name || phone} rejected a job offer`);
  }
};

const setEngineerOnline = async (phone, engineer) => {
  updateEngineerStatus(phone, 'available');
  await sendWhatsAppText(phone, `✅ You're now ONLINE and will receive job alerts`);
  console.log(`🌐 Engineer ${phone.substring(0, 10)}... is now online`);
};

const setEngineerOffline = async (phone, engineer) => {
  updateEngineerStatus(phone, 'offline');
  await sendWhatsAppText(phone, `🛑 You're now OFFLINE. No job alerts will be sent.`);
  console.log(`🌐 Engineer ${phone.substring(0, 10)}... is now offline`);
};

const sendJobStatus = async (phone, accountType) => {
  const jobs = getJobsByStatus(null, phone);
  
  if (jobs.length === 0) {
    await sendWhatsAppText(phone, '📭 No active jobs found.');
    return;
  }
  
  let statusText = '';
  
  if (accountType === 'engineer') {
    statusText = `🔧 Your Jobs:\n\n`;
    jobs.forEach(job => {
      statusText += `📋 ${job.id} - ${job.jobType}\n`;
      statusText += `📍 ${job.location}\n`;
      statusText += `💰 ${job.payout}\n`;
      statusText += `📊 Status: ${job.status}\n\n`;
    });
  } else {
    statusText = `📋 Your Service Requests:\n\n`;
    jobs.forEach(job => {
      statusText += `🆔 ${job.id} - ${job.jobType}\n`;
      statusText += `👨‍🔧 Engineer: ${job.engineerName || 'Not assigned'}\n`;
      statusText += `📍 Location: ${job.location}\n`;
      statusText += `📊 Status: ${job.status}\n\n`;
    });
  }
  
  statusText += `\nNeed help? Call ${SUPPORT_PHONE}`;
  
  await sendWhatsAppText(phone, statusText);
};

const sendEarningsStatus = async (phone, engineer) => {
  if (!engineer) {
    await sendWhatsAppText(phone, '❌ Engineer profile not found');
    return;
  }
  
  const completedJobs = getJobsForEngineer(phone, 'completed');
  const totalEarnings = completedJobs.reduce((sum, job) => {
    const payout = parseInt(job.payout.replace(/[^0-9]/g, '')) || 0;
    return sum + payout;
  }, 0);
  
  const earningsText = `💰 Your Earnings Summary:\n\n` +
                       `Completed Jobs: ${completedJobs.length}\n` +
                       `Total Earnings: ₹${totalEarnings}\n` +
                       `Next Payout: Immediate (after job completion)\n\n` +
                       `Latest job: ${completedJobs[0]?.jobType || 'None'}\n` +
                       `Amount: ${completedJobs[0]?.payout || '₹0'}\n\n` +
                       `Your UPI ID: ${engineer.upiId || 'Not set'}\n` +
                       `Call ${SUPPORT_PHONE} for payout issues`;
  
  await sendWhatsAppText(phone, earningsText);
};

const handleCustomerCancellation = async (phone, response, customer) => {
  // Extract order ID from response (e.g., "CANCEL ORD123" or "CANCELORD123")
  const orderMatch = response.match(/CANCEL\s*([A-Z0-9]+)/i);
  const orderId = orderMatch ? orderMatch[1] : null;
  
  if (!orderId) {
    await sendWhatsAppText(phone, '❌ Please specify order ID: CANCEL ORD123');
    return;
  }
  
  const job = getJob(orderId);
  if (!job) {
    await sendWhatsAppText(phone, `❌ Order ${orderId} not found`);
    return;
  }
  
  if (['completed', 'cancelled'].includes(job.status)) {
    await sendWhatsAppText(phone, `ℹ️ Order ${orderId} is already ${job.status}`);
    return;
  }
  
  // Cancel the job
  updateJobStatus(orderId, 'cancelled', {
    cancelledBy: phone,
    cancelledAt: new Date().toISOString()
  });
  
  // If engineer was assigned, notify them
  if (job.status === 'accepted' || job.status === 'engineer_assigned') {
    const engineer = getEngineerByPhone(job.engineerPhone);
    if (engineer) {
      await sendWhatsAppText(job.engineerPhone, 
        `❌ Job ${orderId} was cancelled by customer. You'll receive new job alerts soon.`);
      updateEngineerStatus(job.engineerPhone, 'available');
    }
  }
  
  await sendWhatsAppText(phone, `✅ Order ${orderId} has been cancelled.`);
  
  // Notify admin
  if (ADMIN_PHONES.length > 0) {
    await sendWhatsAppText(ADMIN_PHONES[0], 
      `🚫 Order ${orderId} cancelled by customer ${customer.name || phone}`);
  }
};

const handlePaymentConfirmation = async (phone, response, customer) => {
  // Similar to cancellation but for payment
  const orderId = response.match(/PAID\s*([A-Z0-9]+)/i)?.[1];
  
  if (!orderId) {
    await sendWhatsAppText(phone, '❌ Please specify order ID: PAID ORD123');
    return;
  }
  
  const job = getJob(orderId);
  if (!job) {
    await sendWhatsAppText(phone, `❌ Order ${orderId} not found`);
    return;
  }
  
  updateJobStatus(orderId, 'paid', {
    paidAt: new Date().toISOString(),
    confirmedBy: phone
  });
  
  await sendWhatsAppText(phone, `✅ Payment confirmed for order ${orderId}. Thank you!`);
  console.log(`💰 Payment confirmed for ${orderId} by ${phone.substring(0, 10)}...`);
};

const sendDefaultResponse = async (phone, accountType) => {
  if (accountType === 'unknown') {
    await sendWhatsAppText(phone, 
      `👋 Welcome! It seems you're not registered yet.\n\n` +
      `Are you a customer needing service or an engineer looking for work?\n` +
      `Reply with:\n` +
      `• CUSTOMER for service\n` +
      `• ENGINEER for work opportunities\n\n` +
      `Or call ${SUPPORT_PHONE} for help`
    );
  } else {
    await sendWhatsAppText(phone, 
      `ℹ️ Sorry, I didn't understand that.\n\n` +
      `Type HELP for available commands.\n` +
      `Call ${SUPPORT_PHONE} for assistance.`
    );
  }
};

// ============================
// 7. ENGINEER MANAGEMENT
// ============================
app.post('/api/engineers/register', async (req, res) => {
  try {
    const { name, phone, upiId, skills, location, experience } = req.body;
    
    if (!name || !phone || !upiId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, phone, upiId'
      });
    }
    
    const formattedPhone = formatPhoneNumber(phone);
    
    // Check if engineer already exists
    const existingEngineer = getEngineerByPhone(formattedPhone);
    if (existingEngineer) {
      return res.status(400).json({
        success: false,
        error: 'Engineer already registered'
      });
    }
    
    // Create engineer profile
    const engineer = {
      id: uuidv4(),
      name,
      phone: formattedPhone,
      upiId,
      skills: skills || ['General Battery Repair'],
      location: location || 'India',
      experience: experience || '1 year',
      status: 'offline',
      rating: 4.5,
      totalJobs: 0,
      totalEarnings: 0,
      registeredAt: new Date().toISOString()
    };
    
    // Save to database (implement in memory-db.js)
    // saveEngineer(engineer);
    
    // Send welcome message
    await sendWhatsAppTemplate(
      phone,
      'engineer_onboarding_complete_v1',
      [name]
    );
    
    res.json({
      success: true,
      message: 'Engineer registered successfully',
      engineerId: engineer.id,
      phone: formattedPhone.substring(0, 10) + '...'
    });
    
  } catch (error) {
    console.error('Error in engineer registration:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// ============================
// 8. ADMIN ENDPOINTS
// ============================
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const activeJobs = getJobsByStatus(['pending_engineer_response', 'accepted', 'engineer_assigned']);
    const completedJobs = getJobsByStatus(['completed']);
    const allEngineers = getAllEngineers();
    
    const activeEngineers = allEngineers.filter(e => e.status === 'available' || e.status === 'on_job');
    const offlineEngineers = allEngineers.filter(e => e.status === 'offline');
    
    res.json({
      success: true,
      data: {
        summary: {
          totalJobs: activeJobs.length + completedJobs.length,
          activeJobs: activeJobs.length,
          completedJobs: completedJobs.length,
          totalEngineers: allEngineers.length,
          activeEngineers: activeEngineers.length,
          offlineEngineers: offlineEngineers.length
        },
        recentJobs: activeJobs.slice(0, 10).map(job => ({
          id: job.id,
          jobType: job.jobType,
          location: job.location,
          status: job.status,
          createdAt: job.createdAt
        })),
        engineerStats: activeEngineers.map(eng => ({
          name: eng.name,
          phone: eng.phone.substring(0, 10) + '...',
          status: eng.status,
          rating: eng.rating,
          totalJobs: eng.totalJobs
        }))
      }
    });
    
  } catch (error) {
    console.error('Error in admin dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to fetch dashboard data'
    });
  }
});

// ============================
// 9. HEALTH & UTILITY ENDPOINTS
// ============================
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'Running',
    service: 'BatteryCare WhatsApp API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    settings: {
      environment: NODE_ENV,
      whatsappConfigured: !!WHATSAPP_API_TOKEN && !!PHONE_NUMBER_ID,
      database: 'in-memory',
      webhookConfigured: true
    },
    endpoints: [
      '/api/notify/job-alert',
      '/api/notify/engineer-assigned',
      '/api/notify/job-completed',
      '/api/notify/payment-request',
      '/api/engineers/register',
      '/api/admin/dashboard',
      '/webhook',
      '/api/health'
    ]
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to BatteryCare WhatsApp API',
    description: 'Backend service for BatteryCare platform notifications',
    version: '1.0.0',
    endpoints: {
      webhook: '/webhook',
      notifications: '/api/notify/*',
      engineers: '/api/engineers/*',
      admin: '/api/admin/*',
      health: '/api/health'
    },
    docs: 'Add /docs for API documentation'
  });
});

// ============================
// 10. ERROR HANDLING
// ============================
app.use((err, req, res, next) => {
  console.error('🚨 Server Error:', err.stack);
  
  res.status(500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
    stack: NODE_ENV === 'development' ? err.stack : undefined
  });
});

// 404 Handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// ============================
// START SERVER
// ============================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
    🔋 BATTERYCARE WHATSAPP API
    ============================
    🚀 Server running on: http://localhost:${PORT}
    📊 Environment: ${NODE_ENV}
    🔐 API Key: ${API_KEY.substring(0, 10)}...
    💬 WhatsApp API: ${WHATSAPP_API_TOKEN ? 'Configured' : 'Not Configured'}
    📞 Support: ${SUPPORT_PHONE}
    ⏰ Started: ${new Date().toLocaleString()}
    ============================
    
    ✅ Available Endpoints:
    • POST   /api/notify/job-alert        → Send job alert to engineer
    • POST   /api/notify/engineer-assigned → Notify customer about engineer
    • POST   /api/notify/job-completed    → Send job completion invoice
    • POST   /api/notify/payment-request  → Send payment link
    • GET    /webhook                    → WhatsApp webhook verification
    • POST   /webhook                    → Receive WhatsApp replies
    • POST   /api/engineers/register     → Register new engineer
    • GET    /api/admin/dashboard        → Admin dashboard
    • GET    /api/health                 → Health check
    
    📱 WhatsApp Commands Engineers Can Use:
    • YES JOB123 → Accept job
    • NO → Reject job
    • ONLINE → Go online
    • OFFLINE → Go offline
    • STATUS → Check job status
    • BALANCE → View earnings
    • HELP → Show help
    
    🔗 Frontend Integration:
    • Set X-API-Key header to: ${API_KEY}
    • Use base URL: http://localhost:${PORT} 
    (or your production domain)
    
    ============================
    `);
  });
}

module.exports = app;
