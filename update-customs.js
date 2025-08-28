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
        console.log(`Order ID: ${multiItemOrders[0].orderId}`);
        console.log(`Items: ${multiItemOrders[0].items.length}`);
        console.log(`Customer: ${multiItemOrders[0].shipTo.name}`);
      }
      
      return {
        orders: multiItemOrders,
        hasMore: response.data.pages > page,
        totalPages: response.data.pages
      };
    } catch (error) {
      console.error('Error fetching orders:', error.response?.data || error.message);
      throw error;
    }
  }

  // Just fetch and display order info - no updates
  async testFetchOnly() {
    console.log('========================================');
    console.log('TEST MODE - FETCH ONLY (NO UPDATES)');
    console.log('========================================\n');
    
    try {
      // Test basic connection first
      console.log('Testing API connection...');
      const testResponse = await shipstation.get('/stores');
      console.log(`✓ API Connection successful. Found ${testResponse.data.length} store(s)\n`);
      
      // Now fetch orders
      const { orders, hasMore, totalPages } = await this.fetchOrdersToUpdate(1);
      
      this.ordersFound = orders.length;
      
      // Display summary
      console.log('\n========================================');
      console.log('FETCH TEST COMPLETE');
      console.log('========================================');
      console.log(`Total multi-item US orders found: ${this.ordersFound}`);
      console.log(`Ready to update when you're ready!`);
      
      // Show first 5 orders that would be updated
      if (orders.length > 0) {
        console.log('\nFirst 5 orders that would be updated:');
        orders.slice(0, 5).forEach(order => {
          console.log(`- Order ${order.orderNumber}: ${order.items.length} items`);
        });
      }
      
    } catch (error) {
      console.error('Fatal error:', error);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
    }
  }
}

// Run the test
async function main() {
  const updater = new ShipStationCustomsUpdater();
  await updater.testFetchOnly();
}

// Only run if this is the main module
if (typeof require !== 'undefined' && require.main === module) {
  main();
}

module.exports = ShipStationCustomsUpdater;
