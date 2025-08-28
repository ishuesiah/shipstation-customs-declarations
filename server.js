const express = require('express');
const multer = require('multer');
const ShipStationCustomsUpdater = require('./update-customs');
const ShopifyCustomsUpdater = require('./shopify-customs-updater');
const ShopifyRulesUpdater = require('./shopify-rules-updater');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ memory: true });

app.use(express.json());

// Root endpoint with HTML interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>ShipStation & Shopify Manager</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .section { margin: 30px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        h2 { color: #333; }
        button { 
          background-color: #dc3545; 
          color: white; 
          padding: 12px 24px; 
          border: none; 
          border-radius: 4px; 
          cursor: pointer;
          font-size: 16px;
          margin: 10px 0;
        }
        button:hover { background-color: #c82333; }
        .test-btn { background-color: #007bff; }
        .test-btn:hover { background-color: #0056b3; }
        .shopify-btn { background-color: #28a745; }
        .shopify-btn:hover { background-color: #218838; }
        .custom-btn { background-color: #17a2b8; }
        .custom-btn:hover { background-color: #117a8b; }
        .order-btn { background-color: #fd7e14; }
        .order-btn:hover { background-color: #e56a0c; }
        #result { margin-top: 20px; padding: 10px; background: #f8f9fa; border-radius: 4px; }
        input[type="file"] { margin: 10px 0; }
        input[type="text"] { padding: 8px; margin: 5px; }
        .note { color: #666; font-size: 14px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>E-commerce Operations Manager</h1>
      
      <!-- ShipStation Section -->
      <div class="section">
        <h2>🚢 ShipStation Management</h2>
        
        <h3>Product Deduplication</h3>
        <button class="test-btn" onclick="testDuplicates()">Test Mode - Show Duplicates</button>
        <button onclick="deactivateDuplicates()">⚠️ Deactivate All Duplicate Products</button>
        
        <h3>Customs Data Management</h3>
        <button class="custom-btn" onclick="autoCustoms()">🤖 Auto-Assign Customs Data (Smart Rules)</button>
        
        <h3>Order Customs Updates</h3>
        <div style="margin: 10px 0;">
          <input type="text" id="testOrderNumber" placeholder="Order # to test (e.g. 52231)">
          <button class="order-btn" onclick="testSingleOrder()">🧪 Test Single Order</button>
        </div>
        <button class="order-btn" onclick="updateAllOrders()">📦 Update All USA Orders Awaiting Shipment</button>
      </div>
      
      <!-- Shopify Section -->
      <div class="section">
        <h2>🛍️ Shopify Product Updates</h2>
        
        <h3>CSV Upload</h3>
        <form id="csvForm">
          <div class="note">CSV columns: sku, title, weight (in grams), hs_code, country_of_origin (2-letter codes)</div>
          <input type="file" id="csvFile" accept=".csv" required>
          <button type="submit" class="shopify-btn">Upload CSV & Update Products</button>
        </form>
        <div class="note">
          ✓ Only updates fields with values in CSV<br>
          ✓ Skips inactive products automatically<br>
          ✓ Matches by SKU+title for duplicate SKUs
        </div>
        
        <h3>Rule-Based Updates</h3>
        <button class="shopify-btn" onclick="applyShopifyRules()">Apply HS/Weight Rules to All Products</button>
      </div>
      
      <div id="result"></div>
      
      <!-- All scripts in one place -->
      <script>
        // ShipStation functions
        function testDuplicates() {
          document.getElementById('result').innerHTML = 'Running test mode... Check Kinsta logs for details.';
          fetch('/test-duplicates')
            .then(res => res.json())
            .then(data => {
              document.getElementById('result').innerHTML = data.message;
            });
        }
        
        function deactivateDuplicates() {
          if (confirm('Are you sure you want to deactivate all duplicate products?')) {
            document.getElementById('result').innerHTML = 'Deactivating duplicates... Check Kinsta logs.';
            fetch('/deactivate-duplicates', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                document.getElementById('result').innerHTML = data.message;
              });
          }
        }
        
        function autoCustoms() {
          if (confirm('This will intelligently assign customs data based on product names. Continue?')) {
            document.getElementById('result').innerHTML = 'Running intelligent customs assignment...';
            fetch('/auto-customs', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                document.getElementById('result').innerHTML = data.message;
              });
          }
        }
        
        function testSingleOrder() {
          const orderNumber = document.getElementById('testOrderNumber').value;
          if (!orderNumber) {
            alert('Please enter an order number');
            return;
          }
          
          if (confirm(\`Test customs update on order \${orderNumber}?\`)) {
            document.getElementById('result').innerHTML = \`Testing order \${orderNumber}...\`;
            fetch(\`/test-order-customs/\${orderNumber}\`, { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                document.getElementById('result').innerHTML = data.message;
              });
          }
        }
        
        function updateAllOrders() {
          if (confirm('Update customs data for all USA orders awaiting shipment? This may take several minutes.')) {
            document.getElementById('result').innerHTML = 'Updating USA orders... Check Kinsta logs for progress.';
            fetch('/update-order-customs', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                document.getElementById('result').innerHTML = data.message;
              });
          }
        }
        
        // Shopify functions
        function applyShopifyRules() {
          if (confirm('This will update all active Shopify products based on title rules. Continue?')) {
            document.getElementById('result').innerHTML = 'Applying rules to all products... This may take 10-20 minutes.';
            fetch('/apply-shopify-rules', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                document.getElementById('result').innerHTML = data.message;
              });
          }
        }
        
        // CSV form handler
        document.getElementById('csvForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const file = document.getElementById('csvFile').files[0];
          const formData = new FormData();
          formData.append('csv', file);
          
          document.getElementById('result').innerHTML = 'Processing CSV... This may take several minutes for large files.';
          
          const response = await fetch('/update-shopify-customs', {
            method: 'POST',
            body: formData
          });
          const data = await response.json();
          document.getElementById('result').innerHTML = data.message + ' - Check Kinsta logs for details.';
        });
      </script>
    </body>
    </html>
  \`);
});

// Health check endpoint - simplified for Kinsta
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ==================== SHIPSTATION ENDPOINTS ====================

// Test duplicates (GET - no changes)
app.get('/test-duplicates', async (req, res) => {
  const updater = new ShipStationCustomsUpdater();
  res.json({ message: 'Test mode started. Check logs to see what would be deactivated.' });
  
  updater.findAndDeactivateDuplicates(true).catch(console.error);
});

// Deactivate duplicates (POST - makes changes)
app.post('/deactivate-duplicates', async (req, res) => {
  const updater = new ShipStationCustomsUpdater();
  res.json({ message: 'Deactivation started. Monitor Kinsta logs for progress.' });
  
  updater.findAndDeactivateDuplicates(false).catch(console.error);
});

// Auto-assign customs data using rules engine
app.post('/auto-customs', async (req, res) => {
  const CustomsRulesEngine = require('./customs-rules-engine');
  const engine = new CustomsRulesEngine();
  
  res.json({ message: 'Intelligent customs update started. Check logs for details.' });
  
  engine.updateAllProducts().catch(console.error);
});

// Test customs update on single order
app.post('/test-order-customs/:orderNumber', async (req, res) => {
  const OrderCustomsUpdater = require('./order-customs-updater');
  const updater = new OrderCustomsUpdater();
  const orderNumber = req.params.orderNumber;
  
  res.json({ message: \`Testing customs update on order \${orderNumber}. Check logs for details.\` });
  
  updater.updateSingleOrder(orderNumber).catch(console.error);
});

// Update customs for all USA orders
app.post('/update-order-customs', async (req, res) => {
  const OrderCustomsUpdater = require('./order-customs-updater');
  const updater = new OrderCustomsUpdater();
  
  res.json({ message: 'Order customs update started for USA orders. Check logs for details.' });
  
  updater.updateOrders({ 
    countryCode: 'US',
    orderStatus: 'awaiting_shipment'
  }).catch(console.error);
});

// ==================== SHOPIFY ENDPOINTS ====================

// Update Shopify products from CSV
app.post('/update-shopify-customs', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded' });
  }

  const csvContent = req.file.buffer.toString('utf-8');
  const updater = new ShopifyCustomsUpdater();
  
  res.json({ message: 'Processing CSV... Check logs for progress.' });
  
  updater.updateFromCSV(csvContent).catch(console.error);
});

// Apply rules to all Shopify products
app.post('/apply-shopify-rules', async (req, res) => {
  const updater = new ShopifyRulesUpdater();
  res.json({ message: 'Applying rules to all Shopify products. Check logs for progress.' });
  
  updater.applyRules().catch(console.error);
});

// ==================== LEGACY ENDPOINTS ====================

// Legacy test endpoint
app.get('/test', async (req, res) => {
  const updater = new ShipStationCustomsUpdater();
  res.json({ message: 'Test fetch started. Check logs for results.' });
  updater.testFetchOnly().catch(console.error);
});

// Legacy update endpoint
app.post('/update', async (req, res) => {
  res.json({ message: 'This endpoint is not implemented. Use specific function endpoints.' });
});

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
