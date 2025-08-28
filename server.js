const express = require('express');
const ShipStationCustomsUpdater = require('./update-customs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Simple status endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>ShipStation Customs Updater</h1>
    <p>Status: Ready</p>
    <p>Endpoints:</p>
    <ul>
      <li>GET /test - Run test update (5 orders)</li>
      <li>POST /update - Run full update</li>
      <li>GET /health - Health check</li>
    </ul>
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
