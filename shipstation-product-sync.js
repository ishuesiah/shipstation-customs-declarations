const axios = require('axios');
const Papa = require('papaparse');
require('dotenv').config();

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;

// Create axios instance with ShipStation auth
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

class ShipStationProductSync {
  constructor(csvData) {
    this.csvProducts = [];
    this.existingProducts = new Map(); // SKU -> product mapping
    this.updated = 0;
    this.created = 0;
    this.skipped = 0;
    this.errors = [];
    
    this.parseCsvData(csvData);
  }
  
  parseCsvData(csvData) {
    // Parse CSV - flexible header mapping
    const parsed = Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim()
    });
    
    if (parsed.errors.length > 0) {
      console.log('CSV parsing warnings:', parsed.errors);
    }
    
    // Map CSV columns to ShipStation fields
    parsed.data.forEach(row => {
      // Map various possible column names
      const product = {
        sku: row['SKU'] || row['sku'] || row['Sku'] || row['Product SKU'],
        name: row['Name'] || row['Product Name'] || row['Title'] || row['Product Title'] || row['name'],
        price: parseFloat(row['Price'] || row['price'] || row['Unit Price'] || 0),
        weightOz: parseFloat(row['Weight'] || row['weight'] || row['Weight (oz)'] || 0),
        customsTariffNumber: row['HS Code'] || row['HS'] || row['Tariff Number'] || row['Customs Tariff'] || row['hs_code'],
        customsDescription: row['Customs Description'] || row['Description'] || row['customs_description'],
        customsValue: parseFloat(row['Customs Value'] || row['customs_value'] || row['Value'] || row['Price'] || 0),
        countryOfOrigin: row['Country'] || row['Country of Origin'] || row['Origin'] || row['country_code'] || 'CA',
        active: row['Active'] !== 'false' && row['Active'] !== '0', // Default to true unless explicitly false
        
        // Optional fields
        internalNotes: row['Notes'] || row['Internal Notes'] || '',
        fulfillmentSku: row['Fulfillment SKU'] || row['fulfillment_sku'] || '',
        warehouseLocation: row['Location'] || row['Warehouse Location'] || '',
        defaultCarrierCode: row['Carrier'] || row['carrier_code'] || '',
        defaultServiceCode: row['Service'] || row['service_code'] || '',
        defaultPackageCode: row['Package'] || row['package_code'] || '',
        defaultIntlCarrierCode: row['Intl Carrier'] || row['intl_carrier'] || '',
        defaultIntlServiceCode: row['Intl Service'] || row['intl_service'] || '',
        defaultIntlPackageCode: row['Intl Package'] || row['intl_package'] || '',
      };
      
      // Only add if we have at least a SKU
      if (product.sku) {
        // Clean up the SKU - ShipStation is case-sensitive
        product.sku = product.sku.trim();
        
        // Convert weight from grams if specified
        if (row['Weight (g)'] || row['weight_g']) {
          product.weightOz = parseFloat(row['Weight (g)'] || row['weight_g']) * 0.035274;
        }
        
        // Remove undefined or empty optional fields
        Object.keys(product).forEach(key => {
          if (product[key] === '' || product[key] === undefined || product[key] === null) {
            delete product[key];
          }
        });
        
        this.csvProducts.push(product);
      } else {
        console.log('Warning: Row missing SKU, skipping:', row);
      }
    });
    
    console.log(`Loaded ${this.csvProducts.length} products from CSV`);
  }
  
  async fetchAllProducts() {
    console.log('\nFetching all existing ShipStation products...');
    
    let page = 1;
    const pageSize = 500; // Max allowed by ShipStation
    let hasMore = true;
    
    while (hasMore) {
      try {
        const response = await shipstationAPI.get('/products', {
          params: {
            page: page,
            pageSize: pageSize
          }
        });
        
        const products = response.data.products;
        
        // Store products by SKU for quick lookup
        products.forEach(product => {
          if (product.sku) {
            // Store with exact SKU as key (case-sensitive)
            this.existingProducts.set(product.sku, product);
          }
        });
        
        console.log(`Fetched page ${page}: ${products.length} products`);
        
        hasMore = products.length === pageSize;
        page++;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`Error fetching page ${page}:`, error.response?.data || error.message);
        hasMore = false;
      }
    }
    
    console.log(`Total existing products in ShipStation: ${this.existingProducts.size}`);
  }
  
  async syncProducts(options = {}) {
    const { createNew = false, updateExisting = true } = options;
    
    console.log('\n========================================');
    console.log('SYNCHRONIZING SHIPSTATION PRODUCTS');
    console.log('========================================');
    console.log(`Mode: ${updateExisting ? 'Update existing' : ''}${createNew ? ', Create new' : ''}\n`);
    
    try {
      // First, fetch all existing products
      await this.fetchAllProducts();
      
      console.log('\nProcessing CSV products...\n');
      
      // Process each product from CSV
      for (const csvProduct of this.csvProducts) {
        const existingProduct = this.existingProducts.get(csvProduct.sku);
        
        if (existingProduct) {
          // Product exists - update it
          if (updateExisting) {
            // Check what needs updating
            const updates = this.getProductUpdates(existingProduct, csvProduct);
            
            if (Object.keys(updates).length > 0) {
              try {
                // Include the productId AND sku in the update (SKU is required by ShipStation API)
                updates.productId = existingProduct.productId;
                updates.sku = existingProduct.sku; // SKU is required even when updating by productId
                
                await shipstationAPI.put(`/products/${existingProduct.productId}`, updates);
                
                this.updated++;
                console.log(`✅ Updated: ${csvProduct.sku} - ${csvProduct.name || existingProduct.name}`);
                
                // Show what was updated
                const changedFields = Object.keys(updates).filter(k => k !== 'productId');
                if (changedFields.length > 0) {
                  console.log(`   Changed: ${changedFields.join(', ')}`);
                }
                
              } catch (error) {
                this.errors.push({
                  sku: csvProduct.sku,
                  action: 'update',
                  error: error.response?.data || error.message
                });
                console.error(`❌ Failed to update ${csvProduct.sku}:`, error.response?.data || error.message);
              }
            } else {
              this.skipped++;
              console.log(`⏭️  Skipped (no changes): ${csvProduct.sku}`);
            }
          }
        } else {
          // Product doesn't exist - create it
          if (createNew) {
            try {
              await shipstationAPI.post('/products', csvProduct);
              
              this.created++;
              console.log(`✨ Created: ${csvProduct.sku} - ${csvProduct.name}`);
              
            } catch (error) {
              this.errors.push({
                sku: csvProduct.sku,
                action: 'create',
                error: error.response?.data || error.message
              });
              console.error(`❌ Failed to create ${csvProduct.sku}:`, error.response?.data || error.message);
            }
          } else {
            console.log(`⚠️  Not found (skipping): ${csvProduct.sku}`);
          }
        }
        
        // Rate limiting - ShipStation allows 2 requests per second
        await new Promise(resolve => setTimeout(resolve, 550));
      }
      
      // Final summary
      console.log('\n========================================');
      console.log('PRODUCT SYNC COMPLETE');
      console.log('========================================');
      console.log(`✅ Updated: ${this.updated} products`);
      console.log(`✨ Created: ${this.created} products`);
      console.log(`⏭️  Skipped (no changes): ${this.skipped} products`);
      console.log(`❌ Errors: ${this.errors.length}`);
      
      if (this.errors.length > 0) {
        console.log('\nErrors encountered:');
        this.errors.forEach(err => {
          console.log(`- ${err.sku} (${err.action}): ${JSON.stringify(err.error)}`);
        });
      }
      
      return {
        updated: this.updated,
        created: this.created,
        skipped: this.skipped,
        errors: this.errors
      };
      
    } catch (error) {
      console.error('Fatal error:', error.response?.data || error.message);
      throw error;
    }
  }
  
  getProductUpdates(existing, csvProduct) {
    const updates = {};
    
    // Check each field for changes
    const fieldsToCompare = [
      'name',
      'price',
      'weightOz',
      'customsTariffNumber',
      'customsDescription',
      'customsValue',
      'countryOfOrigin',
      'active',
      'internalNotes',
      'fulfillmentSku',
      'warehouseLocation',
      'defaultCarrierCode',
      'defaultServiceCode',
      'defaultPackageCode',
      'defaultIntlCarrierCode',
      'defaultIntlServiceCode',
      'defaultIntlPackageCode'
    ];
    
    fieldsToCompare.forEach(field => {
      // Only update if CSV has this field and it's different
      if (csvProduct.hasOwnProperty(field) && csvProduct[field] !== existing[field]) {
        // Special handling for numeric fields
        if (['price', 'weightOz', 'customsValue'].includes(field)) {
          // Only update if the difference is significant (not just rounding)
          if (Math.abs((csvProduct[field] || 0) - (existing[field] || 0)) > 0.01) {
            updates[field] = csvProduct[field];
          }
        } else {
          updates[field] = csvProduct[field];
        }
      }
    });
    
    return updates;
  }
}

module.exports = ShipStationProductSync;
