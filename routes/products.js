// Product management routes

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ShopifyAPI } = require('../shopify-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

// Initialize Shopify API
const shopify = new ShopifyAPI();

// Load HTML template
const productManagerHTML = fs.readFileSync(path.join(__dirname, '../views/product-manager.html'), 'utf8');

// Main product manager page
router.get('/', requireAuth, (req, res) => {
  res.send(productManagerHTML);
});

// API: Get all products
router.get('/api/products', requireAuthApi, async (req, res) => {
  try {
    const products = await shopify.getAllProductsWithInventory();
    const counts = new Map();
    const dups = new Set();
    products.forEach(p => p.variants.forEach(v => {
      const sku = String(v.sku || '').trim();
      if (!sku) return;
      const c = (counts.get(sku) || 0) + 1;
      counts.set(sku, c);
      if (c > 1) dups.add(sku);
    }));
    res.json({ products, duplicates: Array.from(dups) });
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

// API: Update products
router.post('/api/products/update', requireAuthApi, async (req, res) => {
  const { updates } = req.body || {};
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'Invalid update data' });
  }
  try {
    const result = await shopify.updateVariants(updates);
    const updatedCount =
      (typeof result?.updated === 'number' ? result.updated : 0) ||
      (Array.isArray(result) ? result.length : 0) ||
      updates.length;

    res.json({ updated: updatedCount, result });
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

module.exports = router;
