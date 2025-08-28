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

// Add rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class ShipStationCustomsUpdater {
  constructor() {
    this.products = [];
    this.duplicates = {};
    this.deactivated = 0;
    this.errors = [];
  }

  // Find and deactivate duplicate products - keeping most recent
  async findAndDeactivateDuplicates(testMode = true) {
    console.log('========================================');
    console.log(testMode ? 'TEST MODE - WILL SHOW WHAT WOULD BE DEACTIVATED' : 'PRODUCTION MODE - WILL DEACTIVATE DUPLICATES');
    console.log('========================================\n');
    console.log('Strategy: Keep most recent product, deactivate older duplicates\n');
    
    try {
      let page = 1;
      let hasMore = true;
      const allProducts = [];
      
      // Fetch all products
      while (hasMore) {
        console.log(`Fetching products page ${page}...`);
        const response = await shipstation.get('/products', {
          params: {
            page: page,
            pageSize: 500
          }
        });
        
        allProducts.push(...response.data.products);
        hasMore = response.data.pages > page;
        page++;
        await delay(500);
      }
      
      console.log(`Total products found: ${allProducts.length}\n`);
      
      // Group by SKU to find duplicates
      const skuGroups = {};
      allProducts.forEach(product => {
        const sku = product.sku ? product.sku.trim() : 'NO_SKU';
        if (!skuGroups[sku]) {
          skuGroups[sku] = [];
        }
        skuGroups[sku].push(product);
      });
      
      // Process duplicates
      console.log('========================================');
      console.log('DUPLICATE ANALYSIS:');
      console.log('========================================\n');
      
      let duplicateSkuCount = 0;
      let totalDuplicateProducts = 0;
      const deactivationPlan = [];
      
      Object.keys(skuGroups).forEach(sku => {
        if (skuGroups[sku].length > 1) {
          duplicateSkuCount++;
          totalDuplicateProducts += skuGroups[sku].length - 1;
          
          // Sort products by date (most recent first)
          // Use modifyDate first, fall back to createDate if modifyDate is null
          const sortedProducts = skuGroups[sku].sort((a, b) => {
            const dateA = new Date(a.modifyDate || a.createDate);
            const dateB = new Date(b.modifyDate || b.createDate);
            return dateB - dateA; // Most recent first
          });
          
          const keepProduct = sortedProducts[0]; // Keep the most recent
          const deactivateProducts = sortedProducts.slice(1); // Deactivate older ones
          
          console.log(`\nSKU: ${sku}`);
          console.log(`  Total instances: ${skuGroups[sku].length}`);
          console.log(`  KEEP (Most Recent): Product ID ${keepProduct.productId}`);
          console.log(`    Name: ${keepProduct.name}`);
          console.log(`    Modified: ${keepProduct.modifyDate || 'Never'}`);
          console.log(`    Created: ${keepProduct.createDate}`);
          console.log(`    HS Code: ${keepProduct.customsTariffNo || 'Not set'}`);
          console.log(`    Customs Desc: ${keepProduct.customsDescription || 'Not set'}`);
          console.log(`    Active: ${keepProduct.active}`);
          
          console.log(`  DEACTIVATE (${deactivateProducts.length} older duplicates):`);
          deactivateProducts.forEach(product => {
            console.log(`    - Product ID ${product.productId}`);
            console.log(`      Name: ${product.name}`);
            console.log(`      Modified: ${product.modifyDate || 'Never'}`);
            console.log(`      Created: ${product.createDate}`);
            console.log(`      Active: ${product.active}`);
            
            // Only add to deactivation plan if currently active
            if (product.active) {
              deactivationPlan.push(product);
            }
          });
        }
      });
      
      console.log('\n========================================');
      console.log('SUMMARY:');
      console.log('========================================');
      console.log(`Unique SKUs with duplicates: ${duplicateSkuCount}`);
      console.log(`Total duplicate products to deactivate: ${deactivationPlan.length}`);
      console.log(`Products that will remain active: ${allProducts.length - deactivationPlan.length}\n`);
      
      if (!testMode && deactivationPlan.length > 0) {
        console.log('Starting deactivation process...\n');
        
        for (const product of deactivationPlan) {
          try {
            // Update product to set active = false
await shipstation.put(`/products/${product.productId}`, {
  productId: product.productId,  // Must include the ID in the body
  sku: product.sku,
  name: product.name,
  price: product.price,
  defaultCost: product.defaultCost,
  length: product.length,
  width: product.width,
  height: product.height,
  weight: product.weight,
  imageUrl: product.imageUrl,
  thumbnailUrl: product.thumbnailUrl,
  customsDescription: product.customsDescription,
  customsValue: product.customsValue,
  customsTariffNo: product.customsTariffNo,
  customsCountryCode: product.customsCountryCode,
  noCustoms: product.noCustoms,
  active: false  // The only field we're actually changing
});
            
            this.deactivated++;
            console.log(`✓ Deactivated: ${product.name} (ID: ${product.productId})`);
            await delay(1500); // Rate limiting
            
          } catch (error) {
            this.errors.push({
              productId: product.productId,
              name: product.name,
              error: error.response?.data || error.message
            });
            console.error(`✗ Failed to deactivate ${product.name}:`, error.response?.data || error.message);
          }
        }
        
        console.log('\n========================================');
        console.log('DEACTIVATION COMPLETE');
        console.log('========================================');
        console.log(`Successfully deactivated: ${this.deactivated} products`);
        console.log(`Errors: ${this.errors.length}`);
        
        if (this.errors.length > 0) {
          console.log('\nFailed deactivations:');
          this.errors.forEach(err => {
            console.log(`  - ${err.name} (ID: ${err.productId}): ${err.error}`);
          });
        }
      } else if (testMode && deactivationPlan.length > 0) {
        console.log('⚠️  TEST MODE - No changes made');
        console.log('Run with testMode = false to actually deactivate duplicates');
      } else {
        console.log('No duplicates to deactivate!');
      }
      
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
    }
  }

  async testFetchOnly() {
    await this.findAndDeactivateDuplicates(false); // Test mode
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
