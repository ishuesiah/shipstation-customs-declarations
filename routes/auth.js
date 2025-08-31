// Authentication routes

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Load HTML templates
const loginHTML = fs.readFileSync(path.join(__dirname, '../views/login.html'), 'utf8');

// Login page
router.get('/login', (req, res) => {
  res.send(loginHTML);
});

// Login API endpoint (demo auth)
router.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (email !== 'info@hemlockandoak.com' || password !== 'TestPassword123') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = 1;
  res.json({ success: true });
});

// Logout
router.get('/logout', (req, res) => { 
  req.session.destroy(); 
  res.redirect('/login'); 
});

module.exports = router;
