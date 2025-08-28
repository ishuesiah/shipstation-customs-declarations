const express = require('express');
const ShipStationCustomsUpdater = require('./update-customs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Simple status endpoint
// Update the HTML in your root endpoint
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
          <div class="note">CSV should contain: sku, weight (in grams), hs_code, country_of_origin (2-letter codes)</div>
          <input type="file" id="csvFile" accept=".csv" required><br>
          <button type="submit" class="shopify-btn">Update Product Weights, HS Codes & Countries</button>
        </form>
        <div class="note">
          ✓ Only updates fields with values in CSV<br>
          ✓ Skips inactive products automatically<br>
          ✓ Matches by SKU or product title
        </div>
      </div>
      
      <div id="result"></div>
      
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

// Test endpoint - just fetches and displays info
app.get('/test', async (req, res) => {
  const updater = new ShipStationCustomsUpdater();
  res.json({ message: 'Test fetch started. Check logs for results.' });
  
  // Run async so we don't timeout the response
  updater.testFetchOnly().catch(console.error);
});

// Production endpoint - updates all orders (NOT IMPLEMENTED YET)
app.post('/update', async (req, res) => {
  const { confirm } = req.body;
  
  if (confirm !== 'yes-update-all') {
    return res.status(400).json({ 
      error: 'Please confirm by sending { "confirm": "yes-update-all" }' 
    });
  }
  
  res.json({ message: 'Update functionality not implemented yet. Use /test first.' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
