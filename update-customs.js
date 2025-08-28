const axios = require('axios');
require('dotenv').config();

// ShipStation v1 API configuration
const API_KEY = process.env.SHIPSTATION_API_KEY;
const API_SECRET = process.env.SHIPSTATION_API_SECRET;
const BASE_URL = 'https://ssapi.shipstation.com';

// Create axios instance with auth
const shipstation = axios.create({
  baseURL: BASE_URL,
  auth: {
    username: API_KEY,
    password: API_SECRET
  },
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add rate limiting to respect ShipStation's 40 requests per minute limit
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class ShipStationCustomsUpdater {
  constructor() {
    this.ordersFound = 0;
    this.multiItemOrders = 0;
  }

  // Fetch orders that need updating (US orders, awaiting shipment, multi-item)
  async fetchOrdersToUpdate(page = 1) {
    try {
      console.log(`Fetching page ${page} of orders...`);
      
      const response = await shipstation.get('/orders', {
        params: {
          orderStatus: 'awaiting_shipment',
          shipCountry: 'US',
          page: page,
          pageSize: 100
        }
      });

      // Log what we got
      console.log(`Total orders found: ${response.data.total}`);
      console.log(`Total pages: ${response.data.pages}`);
      console.log(`Orders on this page: ${response.data.orders.length}`);
      
      // Filter for orders with 2+ items
      const multiItemOrders = response.data.orders.filter(order => 
        order.items && order.items.length > 1
      );

      console.log(`Multi-item orders on this page: ${multiItemOrders.length}`);
      
      // Log first order details if any exist
      if (multiItemOrders.length > 0) {
        console.log('\nFirst multi-item order details:');
        console.log(`Order Number: ${multiItemOrders[0].orderNumber}`);
