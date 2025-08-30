// server.js - Clean slate Shopify Product Manager
const express = require('express');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { ShopifyAPI } = require('./shopify-api.js');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'hemlock-oak-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,  // Change this to false
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'  // Add this
  },
  proxy: true  // Add this for Kinsta
}));

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
};

// Initialize Shopify API connection
const shopify = new ShopifyAPI();

// ==================== ROUTES ====================

// Login page
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login - Hemlock & Oak Manager</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .login-container {
          background: white;
          padding: 3rem;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          width: 100%;
          max-width: 400px;
        }
        
        h1 {
          color: #333;
          margin-bottom: 0.5rem;
          font-size: 1.8rem;
        }
        
        .subtitle {
          color: #666;
          margin-bottom: 2rem;
          font-size: 0.95rem;
        }
        
        .form-group {
          margin-bottom: 1.5rem;
        }
        
        label {
          display: block;
          margin-bottom: 0.5rem;
          color: #555;
          font-weight: 500;
        }
        
        input {
          width: 100%;
          padding: 0.75rem;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          font-size: 1rem;
          transition: border-color 0.3s;
        }
        
        input:focus {
          outline: none;
          border-color: #667eea;
        }
        
        button {
          width: 100%;
          padding: 0.875rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        
        button:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
        }
        
        .error {
          background: #fee;
          color: #c33;
          padding: 0.75rem;
          border-radius: 8px;
          margin-bottom: 1rem;
          display: none;
        }
        
        .setup-note {
          margin-top: 1.5rem;
          padding-top: 1.5rem;
          border-top: 1px solid #e0e0e0;
          color: #666;
          font-size: 0.9rem;
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <h1>Hemlock & Oak</h1>
        <p class="subtitle">Product Management System</p>
        
        <div id="error" class="error"></div>
        
        <form id="loginForm">
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required value="info@hemlockandoak.com" readonly>
          </div>
          
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autofocus>
          </div>
          
          <button type="submit">Sign In</button>
        </form>
        
        <div class="setup-note">
          First time? Use the setup endpoint to create your password.
        </div>
      </div>
      
      <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const errorDiv = document.getElementById('error');
          
          try {
            const response = await fetch('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: document.getElementById('email').value,
                password: document.getElementById('password').value
              })
            });
            
            const data = await response.json();
            
            if (response.ok) {
              window.location.href = '/';
            } else {
              errorDiv.textContent = data.error || 'Login failed';
              errorDiv.style.display = 'block';
            }
          } catch (error) {
            errorDiv.textContent = 'Connection error. Please try again.';
            errorDiv.style.display = 'block';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Login API endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (email !== 'info@hemlockandoak.com' || password !== 'TestPassword123') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.userId = 1;
    res.json({ success: true });
});

// Logout endpoint
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Main application (protected)
app.get('/', requireAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Shopify Product Manager - Hemlock & Oak</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: #f8f9fa;
          color: #333;
        }
        
        /* Header */
        .header {
          background: white;
          border-bottom: 1px solid #e0e0e0;
          padding: 1rem 2rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          position: sticky;
          top: 0;
          z-index: 100;
        }
        
        .header h1 {
          font-size: 1.5rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        
        .header-actions {
          display: flex;
          gap: 1rem;
        }
        
        /* Buttons */
        .btn {
          padding: 0.5rem 1rem;
          border-radius: 6px;
          border: none;
          font-size: 0.9rem;
          cursor: pointer;
          transition: all 0.2s;
          font-weight: 500;
        }
        
        .btn-primary {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        
        .btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }
        
        .btn-secondary {
          background: white;
          color: #666;
          border: 1px solid #e0e0e0;
        }
        
        .btn-secondary:hover {
          background: #f5f5f5;
        }
        
        .btn-danger {
          background: #dc3545;
          color: white;
        }
        
        /* Controls Bar */
        .controls {
          background: white;
          padding: 1.5rem 2rem;
          border-bottom: 1px solid #e0e0e0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 1rem;
        }
        
        .search-box {
          flex: 1;
          max-width: 400px;
        }
        
        .search-box input {
          width: 100%;
          padding: 0.5rem 1rem;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          font-size: 0.9rem;
        }
        
        .filter-group {
          display: flex;
          gap: 0.5rem;
          align-items: center;
        }
        
        /* Status Messages */
        .status-bar {
          background: white;
          padding: 1rem 2rem;
          display: none;
          align-items: center;
          gap: 1rem;
          border-bottom: 1px solid #e0e0e0;
        }
        
        .status-bar.active {
          display: flex;
        }
        
        .status-bar.error {
          background: #fee;
          color: #c33;
        }
        
        .status-bar.success {
          background: #efe;
          color: #3c3;
        }
        
        .status-bar.warning {
          background: #ffeaa7;
          color: #d63031;
        }
        
        /* Product Table */
        .table-container {
          background: white;
          margin: 1rem;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        
        table {
          width: 100%;
          border-collapse: collapse;
        }
        
        thead {
          background: #f8f9fa;
          border-bottom: 2px solid #e0e0e0;
        }
        
        th {
          padding: 1rem;
          text-align: left;
          font-weight: 600;
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #666;
        }
        
        td {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid #f0f0f0;
        }
        
        tbody tr:hover {
          background: #f8f9fa;
        }
        
        /* Editable cells */
        .editable {
          position: relative;
          cursor: text;
        }
        
        .editable:hover {
          background: #f0f4ff;
        }
        
        .editable input {
          width: 100%;
          padding: 0.25rem;
          border: 2px solid #667eea;
          border-radius: 4px;
          font-size: 0.9rem;
        }
        
        .cell-modified {
          background: #fffae6 !important;
          position: relative;
        }
        
        .cell-modified::after {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          background: #f39c12;
        }
        
        /* SKU Errors */
        .sku-error {
          background: #fee !important;
          color: #c33;
        }
        
        .duplicate-indicator {
          display: inline-block;
          background: #dc3545;
          color: white;
          padding: 0.2rem 0.5rem;
          border-radius: 4px;
          font-size: 0.75rem;
          margin-left: 0.5rem;
        }
        
        /* Loading Spinner */
        .loading {
          display: none;
          text-align: center;
          padding: 3rem;
        }
        
        .loading.active {
          display: block;
        }
        
        .spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid #667eea;
          border-radius: 50%;
          width: 40px;
          height: 40px;
          animation: spin 1s linear infinite;
          margin: 0 auto;
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        /* Error Log Panel */
        .error-panel {
          position: fixed;
          right: -400px;
          top: 0;
          width: 400px;
          height: 100vh;
          background: white;
          box-shadow: -2px 0 10px rgba(0,0,0,0.1);
          transition: right 0.3s;
          z-index: 200;
        }
        
        .error-panel.open {
          right: 0;
        }
        
        .error-panel-header {
          padding: 1.5rem;
          background: #dc3545;
          color: white;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .error-panel-content {
          padding: 1rem;
          height: calc(100vh - 80px);
          overflow-y: auto;
        }
        
        .error-item {
          padding: 1rem;
          border-bottom: 1px solid #e0e0e0;
        }
        
        .error-item-title {
          font-weight: 600;
          color: #dc3545;
          margin-bottom: 0.5rem;
        }
        
        /* Stats Bar */
        .stats-bar {
          background: white;
          padding: 1rem 2rem;
          display: flex;
          gap: 2rem;
          border-bottom: 1px solid #e0e0e0;
        }
        
        .stat-item {
          display: flex;
          flex-direction: column;
        }
        
        .stat-label {
          font-size: 0.8rem;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .stat-value {
          font-size: 1.5rem;
          font-weight: 600;
          color: #333;
        }
      </style>
    </head>
    <body>
      <!-- Header -->
      <div class="header">
        <h1>Shopify Product Manager</h1>
        <div class="header-actions">
          <button class="btn btn-secondary" onclick="showErrors()">
            Error Log <span id="errorCount" style="display: none; background: #dc3545; color: white; padding: 2px 6px; border-radius: 10px; margin-left: 5px;">0</span>
          </button>
          <button class="btn btn-secondary" onclick="location.href='/logout'">Logout</button>
        </div>
      </div>
      
      <!-- Status Bar -->
      <div id="statusBar" class="status-bar">
        <span id="statusMessage"></span>
      </div>
      
      <!-- Stats Bar -->
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-label">Total Products</span>
          <span class="stat-value" id="totalProducts">0</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Unique SKUs</span>
          <span class="stat-value" id="uniqueSkus">0</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Duplicate SKUs</span>
          <span class="stat-value" id="duplicateSkus" style="color: #dc3545;">0</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Modified</span>
          <span class="stat-value" id="modifiedCount" style="color: #f39c12;">0</span>
        </div>
      </div>
      
      <!-- Controls -->
      <div class="controls">
        <div class="search-box">
          <input type="text" id="searchInput" placeholder="Search products, SKUs, variants..." onkeyup="filterTable()">
        </div>
        
        <div class="filter-group">
          <label>
            <input type="checkbox" id="showDuplicatesOnly" onchange="filterTable()">
            Show duplicates only
          </label>
          <label>
            <input type="checkbox" id="showModifiedOnly" onchange="filterTable()">
            Show modified only
          </label>
        </div>
        
        <div class="header-actions">
          <button class="btn btn-secondary" onclick="refreshProducts()">
            🔄 Refresh from Shopify
          </button>
          <button class="btn btn-primary" onclick="saveChanges()" id="saveBtn">
            💾 Save Changes to Shopify
          </button>
        </div>
      </div>
      
      <!-- Loading -->
      <div id="loading" class="loading">
        <div class="spinner"></div>
        <p style="margin-top: 1rem; color: #666;">Loading products from Shopify...</p>
      </div>
      
      <!-- Product Table -->
      <div class="table-container">
        <table id="productTable">
          <thead>
            <tr>
              <th>Select</th>
              <th>Status</th>
              <th>Product Title</th>
              <th>Variant</th>
              <th>SKU</th>
              <th>Price</th>
              <th>Inventory</th>
              <th>Weight (g)</th>
              <th>HS Code</th>
              <th>Country</th>
            </tr>
          </thead>
          <tbody id="productTableBody">
            <!-- Products will be loaded here -->
          </tbody>
        </table>
      </div>
      
      <!-- Error Panel -->
      <div id="errorPanel" class="error-panel">
        <div class="error-panel-header">
          <h3>Error Log</h3>
          <button class="btn btn-secondary" style="background: white; color: #333;" onclick="closeErrors()">✕</button>
        </div>
        <div class="error-panel-content" id="errorPanelContent">
          <!-- Errors will be displayed here -->
        </div>
      </div>
      
      <script>
        let products = [];
        let modifiedData = new Map();
        let duplicateSkus = new Set();
        
        // Load products on page load
        window.addEventListener('DOMContentLoaded', () => {
          refreshProducts();
        });
        
        async function refreshProducts() {
          const loading = document.getElementById('loading');
          const statusBar = document.getElementById('statusBar');
          const statusMessage = document.getElementById('statusMessage');
          
          loading.classList.add('active');
          statusBar.className = 'status-bar';
          
          try {
            const response = await fetch('/api/products');
            const data = await response.json();
            
            if (!response.ok) throw new Error(data.error);
            
            products = data.products;
            duplicateSkus = new Set(data.duplicates);
            modifiedData.clear();
            
            renderTable();
            updateStats();
            
            statusBar.className = 'status-bar active success';
            statusMessage.textContent = \`Loaded \${products.length} products successfully\`;
            
            setTimeout(() => {
              statusBar.className = 'status-bar';
            }, 3000);
            
          } catch (error) {
            statusBar.className = 'status-bar active error';
            statusMessage.textContent = 'Failed to load products: ' + error.message;
          } finally {
            loading.classList.remove('active');
          }
        }
        
        function renderTable() {
          const tbody = document.getElementById('productTableBody');
          tbody.innerHTML = '';
          
          products.forEach(product => {
            product.variants.forEach(variant => {
              const row = tbody.insertRow();
              const isDuplicate = duplicateSkus.has(variant.sku);
              const variantId = variant.id;
               
              // Checkbox area
              const checkCell = row.insertCell();
            checkCell.innerHTML = '<input type="checkbox" class="select-for-update" data-variant-id="${variantId}">';

              // Status cell
              const statusCell = row.insertCell();
              if (isDuplicate) {
                statusCell.innerHTML = '<span class="duplicate-indicator">DUPLICATE</span>';
              }
              
              // Product title
              row.insertCell().textContent = product.title;
              
              // Variant title
              row.insertCell().textContent = variant.title || 'Default';
              
              // SKU (editable)
              const skuCell = row.insertCell();
              skuCell.className = isDuplicate ? 'editable sku-error' : 'editable';
              skuCell.innerHTML = \`<span data-variant-id="\${variantId}" data-field="sku" class="editable-span">\${variant.sku || ''}</span>\`;
              
              // Price (editable)
              const priceCell = row.insertCell();
              priceCell.className = 'editable';
              priceCell.innerHTML = \`<span onclick="makeEditable(this, '\${variantId}', 'price')">$\${variant.price}</span>\`;
              
              // Inventory
              row.insertCell().textContent = variant.inventory_quantity || '0';
              
              // Weight (editable)
              const weightCell = row.insertCell();
              weightCell.className = 'editable';
              weightCell.innerHTML = \`<span onclick="makeEditable(this, '\${variantId}', 'weight')">\${variant.weight || ''}</span>\`;
              
              // HS Code (editable)
              const hsCell = row.insertCell();
              hsCell.className = 'editable';
              hsCell.innerHTML = \`<span onclick="makeEditable(this, '\${variantId}', 'harmonized_system_code')">\${variant.harmonized_system_code || ''}</span>\`;
              
              // Country (editable)
              const countryCell = row.insertCell();
              countryCell.className = 'editable';
              countryCell.innerHTML = \`<span onclick="makeEditable(this, '\${variantId}', 'country_code_of_origin')">\${variant.country_code_of_origin || ''}</span>\`;
              
              // Store row reference
              row.dataset.variantId = variantId;
              row.dataset.productTitle = product.title.toLowerCase();
              row.dataset.variantTitle = (variant.title || '').toLowerCase();
              row.dataset.sku = (variant.sku || '').toLowerCase();
            });
          });
        }
        
        function makeEditable(span, variantId, field) {
          const currentValue = span.textContent.replace('$', '');
          const input = document.createElement('input');
          input.type = field === 'price' || field === 'weight' ? 'number' : 'text';
          input.value = currentValue;
          
          if (field === 'price') input.step = '0.01';
          if (field === 'weight') input.step = '1';
          
          input.onblur = () => saveEdit(input, span, variantId, field);
          input.onkeypress = (e) => {
            if (e.key === 'Enter') {
              input.blur();
            }
          };
          
          span.parentElement.innerHTML = '';
          span.parentElement.appendChild(input);
          input.focus();
          input.select();
        }
        
        function saveEdit(input, originalSpan, variantId, field) {
          const newValue = input.value;
          const cell = input.parentElement;
          
          // Store the change
          if (!modifiedData.has(variantId)) {
            modifiedData.set(variantId, {});
          }
          modifiedData.get(variantId)[field] = newValue;
          
          // Update display
          let displayValue = newValue;
          if (field === 'price' && newValue) displayValue = '$' + newValue;
          
          cell.innerHTML = \`<span onclick="makeEditable(this, '\${variantId}', '\${field}')">\${displayValue}</span>\`;
          cell.classList.add('cell-modified');
          
          updateStats();
          checkForDuplicateSku(newValue, field);
        }
        
        function checkForDuplicateSku(value, field) {
          if (field !== 'sku') return;
          
          // Recheck for duplicates
          const skuCounts = {};
          products.forEach(product => {
            product.variants.forEach(variant => {
              let sku = variant.sku;
              if (modifiedData.has(variant.id) && modifiedData.get(variant.id).sku !== undefined) {
                sku = modifiedData.get(variant.id).sku;
              }
              if (sku) {
                skuCounts[sku] = (skuCounts[sku] || 0) + 1;
              }
            });
          });
          
          duplicateSkus.clear();
          Object.entries(skuCounts).forEach(([sku, count]) => {
            if (count > 1) duplicateSkus.add(sku);
          });
          
          renderTable();
        }
        
        function updateStats() {
          const uniqueSkusSet = new Set();
          const skuCounts = {};
          
          products.forEach(product => {
            product.variants.forEach(variant => {
              let sku = variant.sku;
              if (modifiedData.has(variant.id) && modifiedData.get(variant.id).sku !== undefined) {
                sku = modifiedData.get(variant.id).sku;
              }
              if (sku) {
                uniqueSkusSet.add(sku);
                skuCounts[sku] = (skuCounts[sku] || 0) + 1;
              }
            });
          });
          
          const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
          const duplicateCount = Object.values(skuCounts).filter(count => count > 1).length;
          
          document.getElementById('totalProducts').textContent = totalVariants;
          document.getElementById('uniqueSkus').textContent = uniqueSkusSet.size;
          document.getElementById('duplicateSkus').textContent = duplicateCount;
          document.getElementById('modifiedCount').textContent = modifiedData.size;
        }
        
        function filterTable() {
          const searchValue = document.getElementById('searchInput').value.toLowerCase();
          const showDuplicates = document.getElementById('showDuplicatesOnly').checked;
          const showModified = document.getElementById('showModifiedOnly').checked;
          
          const rows = document.querySelectorAll('#productTableBody tr');
          
          rows.forEach(row => {
            const variantId = row.dataset.variantId;
            const isDuplicate = row.querySelector('.duplicate-indicator') !== null;
            const isModified = modifiedData.has(variantId);
            
            let showRow = true;
            
            // Search filter
            if (searchValue) {
              const searchableText = row.dataset.productTitle + ' ' + 
                                   row.dataset.variantTitle + ' ' + 
                                   row.dataset.sku;
              showRow = searchableText.includes(searchValue);
            }
            
            // Duplicate filter
            if (showRow && showDuplicates) {
              showRow = isDuplicate;
            }
            
            // Modified filter
            if (showRow && showModified) {
              showRow = isModified;
            }
            
            row.style.display = showRow ? '' : 'none';
          });
        }
        
        async function saveChanges() {
          if (modifiedData.size === 0) {
            showStatus('No changes to save', 'warning');
            return;
          }
          
          if (duplicateSkus.size > 0) {
            if (!confirm(\`Warning: You have \${duplicateSkus.size} duplicate SKUs. Continue saving?\`)) {
              return;
            }
          }
          
          const saveBtn = document.getElementById('saveBtn');
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          
          try {
            const updates = Array.from(modifiedData.entries()).map(([id, changes]) => ({
              id,
              ...changes
            }));
            
            const response = await fetch('/api/products/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates })
            });
            
            const result = await response.json();
            
            if (!response.ok) throw new Error(result.error);
            
            showStatus(\`Successfully updated \${result.updated} products\`, 'success');
            
            // Clear modified data and refresh
            modifiedData.clear();
            setTimeout(() => refreshProducts(), 2000);
            
          } catch (error) {
            showStatus('Failed to save: ' + error.message, 'error');
          } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Changes to Shopify';
          }
        }
        
        function showStatus(message, type) {
          const statusBar = document.getElementById('statusBar');
          const statusMessage = document.getElementById('statusMessage');
          
          statusBar.className = \`status-bar active \${type}\`;
          statusMessage.textContent = message;
          
          setTimeout(() => {
            statusBar.className = 'status-bar';
          }, 5000);
        }
        
        function showErrors() {
          document.getElementById('errorPanel').classList.add('open');
        }
        
        function closeErrors() {
          document.getElementById('errorPanel').classList.remove('open');
        }
      </script>
    </body>
    </html>
  `);
});

// API: Get all products
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const products = await shopify.getAllProducts();
    
    // Check for duplicate SKUs
    const skuMap = new Map();
    const duplicates = [];
    
    products.forEach(product => {
      product.variants.forEach(variant => {
        if (variant.sku) {
          if (skuMap.has(variant.sku)) {
            duplicates.push(variant.sku);
          }
          skuMap.set(variant.sku, (skuMap.get(variant.sku) || 0) + 1);
        }
      });
    });
    
    // Log duplicates to database
    
    res.json({ 
      products, 
      duplicates: [...new Set(duplicates)]
    });
    
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Update products
app.post('/api/products/update', requireAuth, async (req, res) => {
  const { updates } = req.body;
  
  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: 'Invalid update data' });
  }
  
  try {
    const results = await shopify.updateVariants(updates);
    res.json(results);
  } catch (error) {
    console.error('Error updating products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
  ========================================
  Shopify Product Manager v2.0
  ========================================
  
  Server running on port ${PORT}
  
  First time setup:
  1. Visit http://localhost:${PORT}/setup to create password
  2. Then login at http://localhost:${PORT}/login
  
  ========================================
  `);
});