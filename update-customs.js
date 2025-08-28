const axios = require('axios');
require('dotenv').config();

// ShipStation v1 API configuration - this is what we need for order management
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
    this.processedCount = 0;
    this.errorCount = 0;
    this.errors = [];
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
          pageSize: 100 // Process 100 at a time
        }
      });

      // Filter for orders with 2+ items
      const multiItemOrders = response.data.orders.filter(order => 
        order.items && order.items.length > 1
      );

      console.log(`Found ${multiItemOrders.length} multi-item US orders on page ${page}`);
      
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

  // Update customs info for a single order
  async updateOrderCustoms(order) {
    try {
      // Build the customs items array based on order items
      const customsItems = order.items.map(item => ({
        customsItemId: item.orderItemId, // Use existing item ID
        description: item.name || 'Product', // Use product name or default
        quantity: item.quantity,
        value: item.unitPrice || 0,
        harmonizedTariffCode: item.harmonizedTariffCode || '', // This is what we want to update
        countryOfOrigin: 'US' // Adjust as needed
      }));

      // Update the order with customs information
      const updateData = {
        orderId: order.orderId,
        advancedOptions: {
          customsItems: customsItems
        }
      };

      console.log(`Updating order ${order.orderNumber} (${order.orderId})`);
      
      await shipstation.post(`/orders/createorder`, updateData);
      
      this.processedCount++;
      console.log(`✓ Updated order ${order.orderNumber}`);
      
      // Rate limiting - wait 1.5 seconds between requests to stay under 40/min
      await delay(1500);
      
    } catch (error) {
      this.errorCount++;
      this.errors.push({
        orderNumber: order.orderNumber,
        orderId: order.orderId,
        error: error.response?.data || error.message
      });
      console.error(`✗ Failed to update order ${order.orderNumber}:`, error.response?.data || error.message);
    }
  }

  // Main process to update all orders
  async processAllOrders(testMode = false) {
    console.log('========================================');
    console.log(testMode ? 'RUNNING IN TEST MODE (5 orders max)' : 'RUNNING IN PRODUCTION MODE');
    console.log('========================================\n');
    
    let page = 1;
    let hasMore = true;
    let totalProcessed = 0;

    while (hasMore) {
      const { orders, hasMore: morePages, totalPages } = await this.fetchOrdersToUpdate(page);
      
      console.log(`\nProcessing page ${page}/${totalPages}`);
      
      for (const order of orders) {
        if (testMode && totalProcessed >= 5) {
          console.log('\nTest limit reached (5 orders)');
          hasMore = false;
          break;
        }
        
        await this.updateOrderCustoms(order);
        totalProcessed++;
      }
      
      page++;
      hasMore = morePages && (!testMode || totalProcessed < 5);
    }

    // Print summary
    console.log('\n========================================');
    console.log('PROCESSING COMPLETE');
    console.log('========================================');
    console.log(`✓ Successfully updated: ${this.processedCount} orders`);
    console.log(`✗ Failed: ${this.errorCount} orders`);
    
    if (this.errors.length > 0) {
      console.log('\nFailed orders:');
      this.errors.forEach(err => {
        console.log(`- Order ${err.orderNumber}: ${JSON.stringify(err.error)}`);
      });
    }
  }
}

// Run the updater
async function main() {
  const updater = new ShipStationCustomsUpdater();
  
  // Start in test mode - change to false for production
  const TEST_MODE = true;
  
  try {
    await updater.processAllOrders(TEST_MODE);
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Only run if this is the main module
if (typeof require !== 'undefined' && require.main === module) {
  main();
}

module.exports = ShipStationCustomsUpdater;
