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

class CustomsRulesEngine {
  constructor() {
    this.updated = 0;
    this.skipped = 0;
    this.errors = [];
    
    // Define rules based on your categories
    // Order matters - more specific rules first
    this.rules = [
      // Inserts - check first since products might have "notebook" in name but be inserts
      {
        keywords: ['insert', 'refill', 'loose', 'pages only'],
        hsCode: '4820.90.0000',
        description: 'Planner inserts (loose refills)',
        country: 'CA'
      },
      
      // Planners
      {
        keywords: ['2026 planner', '2025 planner', 'undated planner', 'daily planner', 'weekly planner', 'monthly planner'],
        hsCode: '4820.10.2010',
        description: 'Planner agenda (bound diary)',
        country: 'CA'
      },
      
      // B5 Notebooks (check before general notebooks)
      {
        keywords: ['b5 notebook', 'b5 journal', 'notebook b5', 'journal b5'],
        hsCode: '4820.10.2030',
        description: 'Notebook (sewn journal, B5 size)',
        country: 'CA'
      },
      
      // A5 and TN Notebooks
      {
        keywords: ['a5 notebook', 'tn notebook', 'travelers notebook', 'notebook a5', 'journal a5', 'dotted notebook', 'lined notebook', 'grid notebook', 'blank notebook'],
        hsCode: '4820.10.2060',
        description: 'Notebook (bound journal)',
        country: 'CA'
      },
      
      // General notebooks (fallback)
      {
        keywords: ['notebook', 'journal'],
        hsCode: '4820.10.2060',
        description: 'Notebook (bound journal)',
        country: 'CA'
      },
      
      // Notepads
      {
        keywords: ['notepad', 'note pad', 'memo pad', 'writing pad'],
        hsCode: '4820.10.2020',
        description: 'Notepad',
        country: 'CA'
      },
      
      // Sticky Notes
      {
        keywords: ['sticky note', 'sticky pad', 'post-it', 'adhesive note'],
        hsCode: '4820.10.2020',
        description: 'Sticky notepad',
        country: 'USA'
      },
      
      // Stickers
      {
        keywords: ['sticker', 'decal', 'label'],
        hsCode: '4911.99.8000',
        description: 'Paper sticker',
        country: 'CA'
      },
      
      // Pens
      {
        keywords: ['pen', 'gel pen', 'ballpoint', 'rollerball', 'fountain pen'],
        hsCode: '9608.10.0000',
        description: 'Gel ink pen',
        country: 'CA'
      },
      
      // Pen Refills
      {
        keywords: ['pen refill', 'ink refill', 'cartridge'],
        hsCode: '9608.60.0000',
        description: 'Refills for ballpoint pen',
        country: 'JP'
      },
      
      // Jewelry - specific types
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
      
      // General jewelry fallback
      {
        keywords: ['jewelry', 'jewellery', 'sterling', 'silver'],
        hsCode: '7113.11.5000',
        description: 'Sterling silver jewellery',
        country: 'CA'
      },
      
      // Accessories
      {
        keywords: ['paper clip', 'paperclip', 'binder clip'],
        hsCode: '8305.90.3010',
        description: 'Office paper clips',
        country: 'CN'
      },
      
      // Planner Accessories
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
      
      // Washi Tape
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
    
    // Check each rule in order
    for (const rule of this.rules) {
      // Check if any keyword matches
      for (const keyword of rule.keywords) {
        if (nameLower.includes(keyword)) {
          return {
            customsTariffNumber: rule.hsCode,
            customsDescription: rule.description,
            countryOfOrigin: rule.country
          };
        }
      }
    }
    
    // No match found
    return null;
  }
  
  async updateAllProducts() {
    console.log('========================================');
    console.log('INTELLIGENT CUSTOMS DATA UPDATE');
    console.log('========================================\n');
    
    try {
      // Fetch all products
      console.log('Fetching all products from ShipStation...');
      let page = 1;
      const pageSize = 100;
      let hasMore = true;
      let allProducts = [];
      
      while (hasMore) {
        const response = await shipstationAPI.get('/products', {
          params: { page, pageSize }
        });
        
        const products = response.data.products;
        allProducts.push(...products);
        
        console.log(`Fetched page ${page}: ${products.length} products`);
        
        if (products.length === 0) {
          hasMore = false;
        } else {
          page++;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      console.log(`\nTotal products to process: ${allProducts.length}\n`);
      
      // Process each product
      for (const product of allProducts) {
        // Skip if already has complete customs data
        if (product.customsTariffNumber && product.customsDescription && product.countryOfOrigin) {
          this.skipped++;
          continue;
        }
        
        // Get customs data based on product name
        const customsData = this.getCustomsData(product.name);
        
        if (!customsData) {
          console.log(`⚠️  No rule matched for: ${product.name}`);
          continue;
        }
        
        // Only update if data is missing or different
        const needsUpdate = 
          !product.customsTariffNumber || 
          !product.customsDescription || 
          !product.countryOfOrigin ||
          product.customsTariffNumber !== customsData.customsTariffNumber ||
          product.customsDescription !== customsData.customsDescription ||
          product.countryOfOrigin !== customsData.countryOfOrigin;
        
        if (needsUpdate) {
          try {
            // Update the product
            await shipstationAPI.put(`/products/${product.productId}`, {
              productId: product.productId,
              sku: product.sku,
              name: product.name,
              ...customsData
            });
            
            this.updated++;
            console.log(`✅ Updated: ${product.sku} - ${product.name}`);
            console.log(`   HS: ${customsData.customsTariffNumber}`);
            console.log(`   Desc: ${customsData.customsDescription}`);
            console.log(`   Country: ${customsData.countryOfOrigin}`);
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 550));
            
          } catch (error) {
            this.errors.push({
              product: product.name,
              error: error.response?.data || error.message
            });
            console.error(`❌ Failed to update ${product.name}:`, error.message);
          }
        } else {
          this.skipped++;
        }
      }
      
      // Summary
      console.log('\n========================================');
      console.log('CUSTOMS UPDATE COMPLETE');
      console.log('========================================');
      console.log(`✅ Updated: ${this.updated} products`);
      console.log(`⏭️  Skipped (already complete): ${this.skipped} products`);
      console.log(`❌ Errors: ${this.errors.length}`);
      
      if (this.errors.length > 0) {
        console.log('\nProducts that need manual review:');
        this.errors.forEach(err => {
          console.log(`- ${err.product}`);
        });
      }
      
    } catch (error) {
      console.error('Fatal error:', error);
      throw error;
    }
  }
}

module.exports = CustomsRulesEngine;
