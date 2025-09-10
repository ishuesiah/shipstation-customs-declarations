// utils/database.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initDB() {
  db = await open({
    filename: path.join(__dirname, '../vip_cache.db'),
    driver: sqlite3.Database
  });

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      total_spent REAL,
      orders_count INTEGER,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      data TEXT
    );
    
    CREATE TABLE IF NOT EXISTS customer_orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER,
      order_data TEXT,
      unfulfilled INTEGER DEFAULT 0,
      total_price REAL,
      created_at TEXT
    );
    
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_spent ON customers(total_spent);
    CREATE INDEX IF NOT EXISTS idx_customer_orders ON customer_orders(customer_id);
  `);
  
  console.log('✅ Database initialized at', path.join(__dirname, '../vip_cache.db'));
  return db;
}

async function getDB() {
  if (!db) {
    await initDB();
  }
  return db;
}

module.exports = { initDB, getDB };