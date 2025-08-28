const axios = require('axios');
const { parse } = require('csv-parse/sync');
require('dotenv').config();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
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
    this.matchedBySku = 0;
    this.matchedByTitle = 0;
  }

  // Parse title to separate product and variant
  parseTitle(fullTitle) {
    if (!fullTitle) return { product: '', variant: '' };
    
    // Handle titles with "Imperfect" - it's part of the product name
    const parts = fullTitle.split(' - ');
    
    if (parts.length === 1) {
      return { product: fullTitle, variant: '' };
    }
    
    // If "Imperfect" appears early, it's probably part of product title
    let productParts = [parts[0]];
    let variantParts = [];
    let foundVariantStart = false;
    
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      // If we haven't found variant yet and part contains "Imperfect" or similar product-like terms
      if (!foundVariantStart && part.toLowerCase().includes('imperfect')) {
        productParts.push(part);
      } else {
        foundVariantStart = true;
        variantParts.push(part);
      }
    }
    
    return {
      product: productParts.join(' - ').trim(),
      variant: variantParts.join(' - ').trim()
    };
  }

  // Try to match a CSV record to a Shopify variant
  findMatchingVariant(record, variantsBySku, productVariantMap) {
    // First try: exact SKU match
    const sku = record.sku?.trim().toUpperCase();
    if (sku && variantsBySku[sku]) {
      this.matchedBySku++;
      return variantsBySku[sku];
    }
    
    // Second try: match by title parsing
    const fullTitle = record.title || record.product_title || record.name || '';
    if (!fullTitle) return null;
    
    const { product: csvProduct, variant: csvVariant } = this.parseTitle(fullTitle);
    
    // Try to find matching product and variant
    for (const [productTitle, variants] of Object.entries(productVariantMap)) {
      // Fuzzy product match - check if titles are similar enough
      if (this.titlesMatch(productTitle, csvProduct)) {
        // If no variant specified in CSV, use default variant
        if (!csvVariant && variants.length === 1) {
          this.matchedByTitle++;
          return variants[0];
        }
        
        // Try to match variant
        for (const variant of variants) {
          if (this.titlesMatch(variant.title, csvVariant) || 
              this.titlesMatch(variant.option1, csvVariant) ||
              this.titlesMatch(variant.option2, csvVariant) ||
              this.titlesMatch(variant.option3, csvVariant)) {
            this.matchedByTitle++;
            return variant;
          }
        }
      }
    }
    
    return null;
  }

  // Fuzzy title matching - handles minor differences
  titlesMatch(title1, title2) {
    if (!title1 || !title2) return false;
    
    // Normalize for comparison
    const normalize = (str) => str
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .replace(/\s+/g, ' ')     // Normalize spaces
      .trim();
    
    const normalized1 = normalize(title1);
    const normalized2 = normalize(title2);
    
    // Exact match after normalization
    if (normalized1 === normalized2) return true;
    
    // Check if one contains the other (for variant matching)
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
      return true;
    }
    
    return false;
  }

  async updateFromCSV(csvContent) {
    console.log('========================================');
    console.log('SHOPIFY CUSTOMS UPDATE');
    console.log('========================================\n');

    try {
      // Parse CSV - flexible column detection
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      console.log(`Found ${records.length} records in CSV\n`);

      // Fetch all products with variants
      console.log('Fetching Shopify products...');
      const { variantsBySku, productVariantMap } = await this.fetchAllProducts();
      const totalVariants = Object.values(productVariantMap).flat().length;
      console.log(`Found ${totalVariants} variants across ${Object.keys(productVariantMap).length} products\n`);

      // Process each CSV record
      for (const record of records) {
        // Find matching variant using multiple strategies
        const variant = this.findMatchingVariant(record, variantsBySku, productVariantMap);
        
        if (!variant) {
          const identifier = record.sku || record.title || record.product_title || 'Unknown';
          console.log(`⚠️ No match found: ${identifier}`);
          this.skipped++;
          continue;
        }

        // Check if update needed
        const needsUpdate = 
          variant.harmonized_system_code !== (record.hs_code || record.harmonized_code) ||
          variant.country_code_of_origin !== (record.country_of_origin || record.country || 'CA');

        if (!needsUpdate) {
          console.log(`✓ Already up to date: ${variant.product_title} - ${variant.title}`);
          this.skipped++;
          continue;
        }

        // Update variant
        try {
          await shopifyAPI.put(`/variants/${variant.id}.json`, {
            variant: {
              id: variant.id,
              harmonized_system_code: record.hs_code || record.harmonized_code || '',
              country_code_of_origin: record.country_of_origin || record.country || 'CA'
            }
          });

          this.updated++;
          console.log(`✅ Updated: ${variant.product_title} - ${variant.title}`);
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 550));
          
        } catch (error) {
          this.errors.push({
            product: `${variant.product_title} - ${variant.title}`,
            error: error.response?.data || error.message
          });
          console.error(`❌ Failed: ${variant.product_title} - ${error.response?.data?.errors || error.message}`);
        }
      }

      console.log('\n========================================');
      console.log('UPDATE COMPLETE');
      console.log('========================================');
      console.log(`✅ Updated: ${this.updated} variants`);
      console.log(`⚠️ Skipped: ${this.skipped} items`);
      console.log(`❌ Errors: ${this.errors.length} variants`);
      console.log(`\nMatching stats:`);
      console.log(`  Matched by SKU: ${this.matchedBySku}`);
      console.log(`  Matched by title: ${this.matchedByTitle}`);

    } catch (error) {
      console.error('Fatal error:', error);
      throw error;
    }
  }

  async fetchAllProducts() {
    const variantsBySku = {};
    const productVariantMap = {}; // product title -> variants
    let hasNextPage = true;
    let pageInfo = null;

    while (hasNextPage) {
      const query = pageInfo 
        ? `products.json?limit=250&page_info=${pageInfo}`
        : `products.json?limit=250`;

      const response = await shopifyAPI.get(query);
      
      response.data.products.forEach(product => {
        productVariantMap[product.title] = [];
        
        product.variants.forEach(variant => {
          // Add product title to variant for easier logging
          variant.product_title = product.title;
          
          if (variant.sku) {
            variantsBySku[variant.sku.trim().toUpperCase()] = variant;
          }
          
          productVariantMap[product.title].push(variant);
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

    return { variantsBySku, productVariantMap };
  }
}

module.exports = ShopifyCustomsUpdater;
