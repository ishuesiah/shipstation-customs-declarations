const express = require('express');
const multer = require('multer');
const ShipStationProductSync = require('./shipstation-product-sync');
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
        #result { margin-top: 20px; padding: 10px; background: #f8f9fa; border-radius: 4px; }
        input[type="file"] { margin: 10px 0; }
        .note { color: #666; font-size: 14px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>E-commerce Operations Manager</h1>
      
      <div class="section">
        <h2>ShipStation Product Management</h2>
        <button class="test-btn" onclick="testDuplicates()">Test Mode - Show Duplicates</button><br>
        <button onclick="deactivateDuplicates()">⚠️ Deactivate All Duplicate Products</button>
      </div>
      
      <div class="section">
        <h2>Shopify Product Updates</h2>
        <form id="csvForm">
          <label><strong>Upload CSV to Update Shopify Products:</strong></label><br>
          <div class="note">CSV columns: sku, title, weight (in grams), hs_code, country_of_origin (2-letter codes)</div>
          <input type="file" id="csvFile" accept=".csv" required><br>
          <button type="submit" class="shopify-btn">Update Product Weights, HS Codes & Countries</button>
        </form>
        <div class="note">
          ✓ Only updates fields with values in CSV<br>
          ✓ Skips inactive products automatically<br>
          ✓ Matches by SKU+title for duplicate SKUs
        </div>
      </div>
      <button class="shopify-btn" onclick="applyShopifyRules()">Apply HS/Weight Rules to All Shopify Products</button>

      
      <div id="result"></div>
      <!-- Add this section to your existing HTML interface -->
<div class="section" style="background: #f0f8ff;">
  <h2>🔄 ShipStation Product Sync (REPLACES/UPDATES)</h2>
  <p style="color: #d9534f;">
    <strong>This will UPDATE existing products by SKU - no more duplicates!</strong>
  </p>
  <p>CSV columns: SKU, Name, HS Code, Weight, Price, Country of Origin, etc.</p>
  <form action="/sync-shipstation-products" method="POST" enctype="multipart/form-data">
    <input type="file" name="csv" accept=".csv" required>
    <div style="margin: 10px 0;">
      <label>
        <input type="checkbox" name="updateExisting" value="true" checked>
        Update existing products
      </label><br>
      <label>
        <input type="checkbox" name="createNew" value="true">
        Create new products (if SKU doesn't exist)
      </label>
    </div>
    <button type="submit" style="background: #5cb85c;" 
            onclick="return confirm('This will UPDATE/REPLACE product data in ShipStation. Continue?')">
      Sync Products (No Duplicates!)
    </button>
  </form>
</div>
      <script>
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
  `);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// ShipStation duplicate testing
app.get('/test-duplicates', async (req, res) => {
  const updater = new ShipStationCustomsUpdater();
  res.json({ message: 'Test mode started. Check logs to see what would be deactivated.' });
  
  updater.findAndDeactivateDuplicates(true).catch(console.error);
});

// ShipStation duplicate deactivation
app.post('/deactivate-duplicates', async (req, res) => {
  const updater = new ShipStationCustomsUpdater();
  res.json({ message: 'Deactivation started. Monitor Kinsta logs for progress.' });
  
  updater.findAndDeactivateDuplicates(false).catch(console.error);
});

// Shopify CSV upload endpoint
app.post('/update-shopify-customs', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded' });
  }

  const csvContent = req.file.buffer.toString('utf-8');
  const updater = new ShopifyCustomsUpdater();
  
  res.json({ message: 'Processing CSV... Check logs for progress.' });
  
  updater.updateFromCSV(csvContent).catch(console.error);
});
//shopify rules updater
app.post('/apply-shopify-rules', async (req, res) => {
  const updater = new ShopifyRulesUpdater();
  res.json({ message: 'Applying rules to all Shopify products. Check logs for progress.' });
  
  updater.applyRules().catch(console.error);
});

//endpoint for sync
app.post('/sync-shipstation-products', requireAuth, upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('<h1>Error</h1><p>Please upload a CSV file</p>');
  }

  try {
    const csvData = req.file.buffer.toString('utf-8');
    const syncer = new ShipStationProductSync(csvData);
    
    // Get options from form
    const options = {
      updateExisting: req.body.updateExisting !== 'false',
      createNew: req.body.createNew === 'true'
    };
    
    const results = await syncer.syncProducts(options);
    
    res.send(`
      <h1>ShipStation Product Sync Complete</h1>
      <p>✅ Updated: ${results.updated} products</p>
      <p>✨ Created: ${results.created} new products</p>
      <p>⏭️ Skipped (no changes): ${results.skipped} products</p>
      <p>❌ Errors: ${results.errors.length}</p>
      ${results.errors.length > 0 ? `
        <h3>Errors:</h3>
        <ul>
          ${results.errors.map(e => `<li>${e.sku} (${e.action}): ${JSON.stringify(e.error)}</li>`).join('')}
        </ul>
      ` : ''}
      <br>
      <a href="/">Back to main page</a>
    `);
  } catch (error) {
    console.error('Product sync error:', error);
    res.status(500).send(`
      <h1>Error</h1>
      <p>${error.message}</p>
      <a href="/">Back to main page</a>
    `);
  }
});

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
  console.log(`Server running on port ${PORT}`);
});
