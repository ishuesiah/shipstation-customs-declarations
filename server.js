// NEW: server-refactored.js - Clean and modular Shopify Product Manager + ShipStation Customs Editor
const express = require('express');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const sessionMiddleware = require('./middleware/session-config');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8080;
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);

// Debug logging for ALL requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  if (req.originalUrl.includes('/api/shipstation/orders') && req.originalUrl.includes('/update')) {
    console.log('  Headers:', req.headers);
    console.log('  Body:', req.body);
  }
  next();
});

// Serve static client assets
app.use(express.static('public'));

// ==================== ROUTES ====================

// Import route modules
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const shipstationRoutes = require('./routes/shipstation');

// Mount routes
app.use(authRoutes);        // Login, logout routes
app.use(productRoutes);      // Product manager routes
app.use(shipstationRoutes);  // ShipStation routes

// ==================== ERROR HANDLING ====================

// Catch-all JSON 404 for unknown API routes
app.use('/api', (req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Unified JSON error handler for API routes
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message || 'Server error';
    return res.status(status).json({ error: msg });
  }
  next(err);
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
  ========================================
  Hemlock & Oak tools (Refactored)
  ========================================
  - Product Manager:        http://localhost:${PORT}/
  - ShipStation Customs:    http://localhost:${PORT}/shipstation
  ========================================
  Server running on port ${PORT}
  ========================================
  `);
});
