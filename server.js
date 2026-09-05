// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

// Middleware to verify Firebase token
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Get user document
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    req.user = {
      uid: decodedToken.uid,
      ...userDoc.data()
    };
    
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Role-based middleware
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    if (req.user.role === 'admin') {
      return next(); // Admin has all permissions
    }
    
    if (Array.isArray(roles)) {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ 
          error: `Access denied. Required roles: ${roles.join(', ')}` 
        });
      }
    } else if (req.user.role !== roles) {
      return res.status(403).json({ 
        error: `Access denied. Required role: ${roles}` 
      });
    }
    
    next();
  };
};

// ==================== PUBLIC ENDPOINTS ====================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// User registration (public)
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, role, phone } = req.body;
    
    // Validate role
    const validRoles = ['customer', 'engineer', 'oem'];
    if (!validRoles.includes(role) && role !== 'admin') {
      return res.status(400).json({ error: 'Invalid role specified' });
    }
    
    // Create Firebase user
    const userRecord = await admin.auth().createUser({
      email,
      password,
      emailVerified: false,
      disabled: false
    });
    
    // Store additional user data in Firestore
    const userData = {
      email,
      name,
      role,
      phone: phone || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Add role-specific fields
    if (role === 'engineer') {
      userData.serviceArea = [];
      userData.skills = [];
      userData.rating = 0;
      userData.earningBalance = 0;
    } else if (role === 'oem') {
      userData.products = [];
      userData.warrantyPeriod = 24;
      userData.contactPerson = name;
    }
    
    await db.collection('users').doc(userRecord.uid).set(userData);
    
    res.status(201).json({
      message: 'User registered successfully',
      userId: userRecord.uid,
      role: role
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    // Note: Firebase handles login on frontend
    // This endpoint is for custom token generation if needed
    res.json({ 
      message: 'Use Firebase client SDK for authentication',
      redirectTo: '/auth/firebase'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CUSTOMER ENDPOINTS ====================
app.get('/api/customer/complaints', verifyToken, requireRole('customer'), async (req, res) => {
  try {
    const complaintsSnapshot = await db.collection('complaints')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    
    const complaints = [];
    complaintsSnapshot.forEach(doc => {
      complaints.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ complaints });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/customer/complaints', verifyToken, requireRole('customer'), async (req, res) => {
  try {
    const {
      batteryType,
      batteryModel,
      serialNumber,
      purchaseDate,
      issueDescription,
      photos = [],
      location,
      contactPhone
    } = req.body;
    
    const complaintData = {
      userId: req.user.uid,
      customerName: req.user.name,
      customerEmail: req.user.email,
      customerPhone: contactPhone || req.user.phone,
      batteryType,
      batteryModel,
      serialNumber,
      purchaseDate,
      issueDescription,
      photos,
      location,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('complaints').add(complaintData);
    
    res.status(201).json({
      message: 'Complaint created successfully',
      complaintId: docRef.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ENGINEER ENDPOINTS ====================
app.get('/api/engineer/jobs', verifyToken, requireRole('engineer'), async (req, res) => {
  try {
    // Get assigned jobs
    const assignedJobsSnapshot = await db.collection('complaints')
      .where('assignedTo', '==', req.user.uid)
      .where('status', 'in', ['assigned', 'in_progress'])
      .orderBy('createdAt', 'desc')
      .get();
    
    // Get available jobs in service area
    const serviceArea = req.user.serviceArea || [];
    let availableJobsSnapshot;
    
    if (serviceArea.length > 0) {
      availableJobsSnapshot = await db.collection('complaints')
        .where('status', '==', 'pending')
        .where('location', 'in', serviceArea)
        .limit(10)
        .get();
    } else {
      availableJobsSnapshot = await db.collection('complaints')
        .where('status', '==', 'pending')
        .limit(10)
        .get();
    }
    
    const assignedJobs = [];
    assignedJobsSnapshot.forEach(doc => {
      assignedJobs.push({ id: doc.id, ...doc.data() });
    });
    
    const availableJobs = [];
    availableJobsSnapshot.forEach(doc => {
      availableJobs.push({ id: doc.id, ...doc.data() });
    });
    
    // Get earnings summary
    const paymentsSnapshot = await db.collection('payments')
      .where('engineerId', '==', req.user.uid)
      .where('status', '==', 'completed')
      .get();
    
    let totalEarnings = 0;
    paymentsSnapshot.forEach(doc => {
      totalEarnings += doc.data().amount || 0;
    });
    
    res.json({
      assignedJobs,
      availableJobs,
      totalEarnings,
      pendingPayment: req.user.earningBalance || 0,
      rating: req.user.rating || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/engineer/jobs/:jobId/accept', verifyToken, requireRole('engineer'), async (req, res) => {
  try {
    const { jobId } = req.params;
    
    await db.collection('complaints').doc(jobId).update({
      assignedTo: req.user.uid,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'assigned',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ message: 'Job accepted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/engineer/jobs/:jobId/complete', verifyToken, requireRole('engineer'), async (req, res) => {
  try {
    const { jobId } = req.params;
    const { repairDetails, partsUsed, photos = [], cost } = req.body;
    
    await db.collection('complaints').doc(jobId).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      repairDetails,
      partsUsed,
      repairPhotos: photos,
      repairCost: cost,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Create payment record
    const paymentData = {
      engineerId: req.user.uid,
      complaintId: jobId,
      amount: cost * 0.7, // 70% for engineer, 30% platform fee
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('payments').add(paymentData);
    
    res.json({ message: 'Job marked as completed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== OEM ENDPOINTS ====================
app.get('/api/oem/products', verifyToken, requireRole('oem'), async (req, res) => {
  try {
    const productsSnapshot = await db.collection('products')
      .where('oemId', '==', req.user.uid)
      .get();
    
    const products = [];
    productsSnapshot.forEach(doc => {
      products.push({ id: doc.id, ...doc.data() });
    });
    
    // Get complaints for products
    const complaintsSnapshot = await db.collection('complaints')
      .where('productModel', 'in', req.user.products || [])
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    const complaints = [];
    complaintsSnapshot.forEach(doc => {
      complaints.push({ id: doc.id, ...doc.data() });
    });
    
    // Calculate statistics
    const stats = {
      totalProducts: products.length,
      activeComplaints: complaints.filter(c => c.status !== 'completed').length,
      resolvedComplaints: complaints.filter(c => c.status === 'completed').length,
      warrantyClaims: complaints.filter(c => {
        const purchaseDate = new Date(c.purchaseDate);
        const warrantyPeriod = req.user.warrantyPeriod || 24;
        const warrantyEnd = new Date(purchaseDate.setMonth(purchaseDate.getMonth() + warrantyPeriod));
        return warrantyEnd > new Date();
      }).length
    };
    
    res.json({ products, complaints, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/oem/products', verifyToken, requireRole('oem'), async (req, res) => {
  try {
    const productData = {
      oemId: req.user.uid,
      ...req.body,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('products').add(productData);
    
    // Update OEM's products list
    await db.collection('users').doc(req.user.uid).update({
      products: admin.firestore.FieldValue.arrayUnion(productData.name)
    });
    
    res.status(201).json({
      message: 'Product added successfully',
      productId: docRef.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN ENDPOINTS ====================
app.get('/api/admin/users', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    
    const users = [];
    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      users.push({
        id: doc.id,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        status: userData.status || 'active',
        createdAt: userData.createdAt?.toDate() || null
      });
    });
    
    // Get system stats
    const complaintsSnapshot = await db.collection('complaints').get();
    const paymentsSnapshot = await db.collection('payments').get();
    
    const stats = {
      totalUsers: users.length,
      totalComplaints: complaintsSnapshot.size,
      totalPayments: paymentsSnapshot.size,
      activeComplaints: Array.from(complaintsSnapshot.docs).filter(doc => 
        doc.data().status !== 'completed').length
    };
    
    res.json({ users, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/complaints', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const complaintsSnapshot = await db.collection('complaints')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    
    const complaints = [];
    complaintsSnapshot.forEach(doc => {
      complaints.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ complaints });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/payments', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const paymentsSnapshot = await db.collection('payments')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    
    const payments = [];
    paymentsSnapshot.forEach(doc => {
      payments.push({ id: doc.id, ...doc.data() });
    });
    
    // Calculate totals
    const totalRevenue = payments.reduce((sum, payment) => sum + (payment.amount || 0), 0);
    const pendingPayments = payments.filter(p => p.status === 'pending');
    const completedPayments = payments.filter(p => p.status === 'completed');
    
    res.json({
      payments,
      totals: {
        revenue: totalRevenue,
        pendingAmount: pendingPayments.reduce((sum, p) => sum + (p.amount || 0), 0),
        completedAmount: completedPayments.reduce((sum, p) => sum + (p.amount || 0), 0)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export for testing
module.exports = app;
