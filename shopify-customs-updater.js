const axios = require('axios');
const { parse } = require('csv-parse/sync');
require('dotenv').config();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // your-store.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';

const shopifyAPI = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`,
  headers: {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

class ShopifyCustomsUpdater {
  constructor() {
    this.updated = 0;
    this.errors = [];
    this.skipped = 0;
  }

  async updateFromCSV(csvContent) {
    console.log('========================================');
    console.log('SHOPIFY CUSTOMS UPDATE');
    console.log('========================================\n');

    try {
      // Parse CSV - expecting columns: sku, hs_code, customs_description, country_of_origin
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      console.log(`Found ${records.length} records in CSV\n`);

      // First, fetch all products with variants
      console.log('Fetching Shopify products...');
      const allVariants = await this.fetchAllVariants();
      console.log(`Found ${allVariants.length} variants in Shopify\n`);

      // Create SKU lookup map
      const variantsBySku = {};
      allVariants.forEach(variant => {
        if (variant.sku) {
          variantsBySku[variant.sku.trim().toUpperCase()] = variant;
        }
      });

      // Process each CSV record
      for (const record of records) {
        const sku = record.sku?.trim().toUpperCase();
        if (!sku) continue;

        const variant = variantsBySku[sku];
        
        if (!variant) {
          console.log(`⚠️ SKU not found in Shopify: ${sku}`);
          this.skipped++;
          continue;
        }

        // Check if update needed
        const needsUpdate = 
          variant.harmonized_system_code !== record.hs_code ||
          variant.country_code_of_origin !== record.country_of_origin;

        if (!needsUpdate) {
          console.log(`✓ Already up to date: ${sku}`);
          this.skipped++;
          continue;
        }

        // Update variant
        try {
          await shopifyAPI.put(`/variants/${variant.id}.json`, {
            variant: {
              id: variant.id,
              harmonized_system_code: record.hs_code || '',
              country_code_of_origin: record.country_of_origin || 'CA'
            }
          });

          this.updated++;
          console.log(`✅ Updated: ${sku} - ${variant.title}`);
          
          // Rate limiting - Shopify allows 2 requests per second
          await new Promise(resolve => setTimeout(resolve, 550));
          
        } catch (error) {
          this.errors.push({
            sku: sku,
            error: error.response?.data || error.message
          });
          console.error(`❌ Failed: ${sku} - ${error.response?.data?.errors || error.message}`);
        }
      }

      console.log('\n========================================');
      console.log('UPDATE COMPLETE');
      console.log('========================================');
      console.log(`✅ Updated: ${this.updated} variants`);
      console.log(`⚠️ Skipped: ${this.skipped} variants`);
      console.log(`❌ Errors: ${this.errors.length} variants`);

    } catch (error) {
      console.error('Fatal error:', error);
      throw error;
    }
  }

  async fetchAllVariants() {
    const variants = [];
    let hasNextPage = true;
    let pageInfo = null;

    while (hasNextPage) {
      const query = pageInfo 
        ? `products.json?fields=variants&limit=250&page_info=${pageInfo}`
        : `products.json?fields=variants&limit=250`;

      const response = await shopifyAPI.get(query);
      
      response.data.products.forEach(product => {
        product.variants.forEach(variant => {
          variants.push(variant);
        });
      });

      // Check for next page
      const linkHeader = response.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>]+)>; rel="next"/);
        pageInfo = match ? match[1] : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return variants;
  }
}

module.exports = ShopifyCustomsUpdater;
