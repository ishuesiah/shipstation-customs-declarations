const axios = require('axios');
require('dotenv').config();

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;

const shipstationAPI = axios.create({
  baseURL: 'https://ssapi.shipstation.com',
  auth: {
    username: SHIPSTATION_API_KEY,
    password: SHIPSTATION_API_SECRET
  },
  headers: {
    'Content-Type': 'application/json'
  }
});

class OrderCustomsUpdater {
  constructor() {
    this.updated = 0;
    this.skipped = 0;
    this.errors = [];
    
    // Same rules as your product updater
    this.rules = [
      {
        keywords: ['insert', 'refill', 'loose', 'pages only'],
        hsCode: '4820.90.0000',
        description: 'Planner inserts (loose refills)',
        country: 'CA'
      },
      {
        keywords: ['2026 planner', '2025 planner', 'undated planner', 'daily planner', 'weekly planner', 'monthly planner'],
        hsCode: '4820.10.2010',
        description: 'Planner agenda (bound diary)',
        country: 'CA'
      },
      {
        keywords: ['b5 notebook', 'b5 journal', 'notebook b5', 'journal b5'],
        hsCode: '4820.10.2030',
        description: 'Notebook (sewn journal, B5 size)',
        country: 'CA'
      },
      {
        keywords: ['a5 notebook', 'tn notebook', 'travelers notebook', 'notebook a5', 'journal a5', 'dotted notebook', 'lined notebook', 'grid notebook', 'blank notebook'],
        hsCode: '4820.10.2060',
        description: 'Notebook (bound journal)',
        country: 'CA'
      },
      {
        keywords: ['notebook', 'journal'],
        hsCode: '4820.10.2060',
        description: 'Notebook (bound journal)',
        country: 'CA'
      },
      {
        keywords: ['notepad', 'note pad', 'memo pad', 'writing pad'],
        hsCode: '4820.10.2020',
        description: 'Notepad',
        country: 'CA'
      },
      {
        keywords: ['sticky note', 'sticky pad', 'post-it', 'adhesive note'],
        hsCode: '4820.10.2020',
        description: 'Sticky notepad',
        country: 'USA'
      },
      {
        keywords: ['sticker', 'decal', 'label'],
        hsCode: '4911.99.8000',
        description: 'Paper sticker',
        country: 'CA'
      },
      {
        keywords: ['pen', 'gel pen', 'ballpoint', 'rollerball', 'fountain pen'],
        hsCode: '9608.10.0000',
        description: 'Gel ink pen',
        country: 'CA'
      },
      {
        keywords: ['pen refill', 'ink refill', 'cartridge'],
        hsCode: '9608.60.0000',
        description: 'Refills for ballpoint pen',
        country: 'JP'
      },
      {
        keywords: ['bracelet'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery bracelets',
        country: 'CA'
      },
      {
        keywords: ['earring'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery earrings',
        country: 'CA'
      },
      {
        keywords: ['pendant', 'necklace'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery pendants',
        country: 'CA'
      },
      {
        keywords: ['charm', 'dangle'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery charms',
        country: 'CA'
      },
      {
        keywords: ['stud', 'post earring'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery studs',
        country: 'CA'
      },
      {
        keywords: ['jewelry', 'jewellery', 'sterling', 'silver'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery',
        country: 'CA'
      },
      {
        keywords: ['paper clip', 'paperclip', 'binder clip'],
        hsCode: '8305.90.3010',
        description: 'Office paper clips',
        country: 'CN'
      },
      {
        keywords: ['elastic band', 'elastic closure', 'notebook elastic', 'planner elastic'],
        hsCode: '6307.90.9800',
        description: 'Elastic for notebook',
        country: 'CN'
      },
      {
        keywords: ['planner charm', 'bookmark charm', 'ribbon charm'],
        hsCode: '7117.90.9000',
        description: 'Charm for notebook ribbon',
        country: 'CN'
      },
      {
        keywords: ['planner pocket', 'notebook pocket', 'folder insert', 'pocket insert'],
        hsCode: '4811.41.2100',
        description: 'Paper pocket for notebook',
        country: 'CN'
      },
      {
        keywords: ['washi', 'decorative tape', 'masking tape', 'craft tape'],
        hsCode: '4811.41.2100',
        description: 'Decorative tape for journaling',
        country: 'JP'
      }
    ];
  }
  
  getCustomsData(productName) {
    if (!productName) return null;
    
    const nameLower = productName.toLowerCase();
    
    for (const rule of this.rules) {
      for (const keyword of rule.keywords) {
        if (nameLower.includes(keyword)) {
          return {
            customsTariffNumber: rule.hsCode,
            customsDescription: rule.description,
            customsCountry: rule.country
          };
        }
      }
    }
    
    return null;
  }
  
  async updateSingleOrder(orderNumber) {
    console.log('========================================');
    console.log(`TESTING CUSTOMS UPDATE ON ORDER ${orderNumber}`);
    console.log('========================================\n');
    
    try {
      // Fetch the specific order
      console.log(`Fetching order ${orderNumber}...`);
      const response = await shipstationAPI.get('/orders', {
        params: {
          orderNumber: orderNumber
        }
      });
      
      if (!response.data.orders || response.data.orders.length === 0) {
        console.log(`❌ Order ${orderNumber} not found`);
        return;
      }
      
      const order = response.data.orders[0];
      console.log(`Found order: ${order.orderNumber}`);
      console.log(`Ship to: ${order.shipTo.country}`);
      console.log(`Status: ${order.orderStatus}\n`);
      
      console.log('Current line items:');
      order.items.forEach(item => {
        console.log(`  - ${item.name}`);
        console.log(`    SKU: ${item.sku}`);
        console.log(`    Current HS: ${item.customsTariffNumber || 'MISSING'}`);
        console.log(`    Current Desc: ${item.customsDescription || 'MISSING'}`);
      });
      
      const updatedItems = [];
      
      console.log('\n🔍 Analyzing items for customs data...\n');
      
      for (const item of order.items) {
        const customsData = this.getCustomsData(item.name);
        
        if (customsData) {
          console.log(`✓ Found match for "${item.name}":`);
          console.log(`  New HS: ${customsData.customsTariffNumber}`);
          console.log(`  New Desc: ${customsData.customsDescription}`);
          console.log(`  Country: ${customsData.customsCountry}`);
          
          updatedItems.push({
            orderItemId: item.orderItemId,
            ...customsData
          });
        } else {
          console.log(`✗ No rule matched for "${item.name}"`);
        }
      }
      
      if (updatedItems.length > 0) {
        console.log(`\n📝 Ready to update ${updatedItems.length} items. Proceeding...`);
        
        const updatePayload = {
          orderId: order.orderId,
          items: updatedItems
        };
        
        await shipstationAPI.put(`/orders/${order.orderId}`, updatePayload);
        console.log(`\n✅ Successfully updated order ${orderNumber}!`);
      } else {
        console.log('\n⏭️ No items need updating.');
      }
      
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
    }
  }
  
  async updateOrders(options = {}) {
    const { 
      countryCode = 'US',  // Target USA orders by default
      orderStatus = 'awaiting_shipment',  // Only unshipped orders
      startDate = null,  // Optional date filter
      endDate = null
    } = options;
    
    console.log('========================================');
    console.log('UPDATING ORDER CUSTOMS DATA');
    console.log('========================================\n');
    console.log(`Target country: ${countryCode}`);
    console.log(`Order status: ${orderStatus}\n`);
    
    try {
      let page = 1;
      const pageSize = 100;
      let hasMore = true;
      let totalOrders = 0;
      
      while (hasMore) {
        // Build query parameters
        const params = {
          page,
          pageSize,
          orderStatus
        };
        
        if (startDate) params.createDateStart = startDate;
        if (endDate) params.createDateEnd = endDate;
        
        console.log(`Fetching page ${page}...`);
        const response = await shipstationAPI.get('/orders', { params });
        const orders = response.data.orders;
        
        if (orders.length === 0) {
          hasMore = false;
          continue;
        }
        
        totalOrders += orders.length;
        
        // Process each order
        for (const order of orders) {
          // Skip if not target country
          if (order.shipTo.country !== countryCode) {
            continue;
          }
          
          let orderNeedsUpdate = false;
          const updatedItems = [];
          
          // Check each line item
          for (const item of order.items) {
            // Skip if already has customs data
            if (item.customsTariffNumber && item.customsDescription) {
              continue;
            }
            
            // Get customs data based on item name
            const customsData = this.getCustomsData(item.name);
            
            if (customsData) {
              // Prepare the update for this item
              updatedItems.push({
                orderItemId: item.orderItemId,
                ...customsData
              });
              orderNeedsUpdate = true;
            } else {
              console.log(`  ⚠️ No rule matched: ${item.name}`);
            }
          }
          
          // Update the order if needed
          if (orderNeedsUpdate && updatedItems.length > 0) {
            try {
              // Update the order with new customs data
              const updatePayload = {
                orderId: order.orderId,
                items: updatedItems
              };
              
              await shipstationAPI.put(`/orders/${order.orderId}`, updatePayload);
              
              this.updated++;
              console.log(`✅ Updated order ${order.orderNumber} (${updatedItems.length} items)`);
              
              // Rate limiting
              await new Promise(resolve => setTimeout(resolve, 550));
              
            } catch (error) {
              this.errors.push({
                order: order.orderNumber,
                error: error.response?.data || error.message
              });
              console.error(`❌ Failed to update order ${order.orderNumber}:`, error.message);
            }
          } else {
            this.skipped++;
          }
        }
        
        page++;
        
        // Rate limiting between pages
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Summary
      console.log('\n========================================');
      console.log('ORDER CUSTOMS UPDATE COMPLETE');
      console.log('========================================');
      console.log(`📊 Total orders processed: ${totalOrders}`);
      console.log(`✅ Updated: ${this.updated} orders`);
      console.log(`⏭️ Skipped: ${this.skipped} orders`);
      console.log(`❌ Errors: ${this.errors.length}`);
      
      if (this.errors.length > 0) {
        console.log('\nFailed orders:');
        this.errors.forEach(err => {
          console.log(`- Order ${err.order}: ${err.error}`);
        });
      }
      
    } catch (error) {
      console.error('Fatal error:', error);
      throw error;
    }
  }
}

module.exports = OrderCustomsUpdater;
