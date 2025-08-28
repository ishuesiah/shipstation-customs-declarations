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
    this.skippedInactive = 0;
    this.matchedBySku = 0;
    this.matchedByTitle = 0;
  }

  // Parse title to separate product and variant
  parseTitle(fullTitle) {
    if (!fullTitle) return { product: '', variant: '' };
    
    const parts = fullTitle.split(' - ');
    
    if (parts.length === 1) {
      return { product: fullTitle, variant: '' };
    }
    
    let productParts = [parts[0]];
    let variantParts = [];
    let foundVariantStart = false;
    
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
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
    
    // Second try: match by title if provided
    const fullTitle = record.title || record.product_title || record.name || '';
    if (!fullTitle) return null;
    
    const { product: csvProduct, variant: csvVariant } = this.parseTitle(fullTitle);
    
    for (const [productTitle, variants] of Object.entries(productVariantMap)) {
      if (this.titlesMatch(productTitle, csvProduct)) {
        if (!csvVariant && variants.length === 1) {
          this.matchedByTitle++;
          return variants[0];
        }
        
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

  titlesMatch(title1, title2) {
    if (!title1 || !title2) return false;
    
    const normalize = (str) => str
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const normalized1 = normalize(title1);
    const normalized2 = normalize(title2);
    
    if (normalized1 === normalized2) return true;
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
      return true;
    }
    
    return false;
  }

  async updateFromCSV(csvContent) {
    console.log('========================================');
    console.log('SHOPIFY PRODUCT UPDATE');
    console.log('========================================\n');
    console.log('Updating: Weight, HS Code, Country of Origin\n');

    try {
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      console.log(`Found ${records.length} records in CSV\n`);

      console.log('Fetching Shopify products...');
      const { variantsBySku, productVariantMap, inactiveProducts } = await this.fetchAllProducts();
      const totalVariants = Object.values(productVariantMap).flat().length;
      console.log(`Found ${totalVariants} variants across ${Object.keys(productVariantMap).length} products\n`);

      for (const record of records) {
        const variant = this.findMatchingVariant(record, variantsBySku, productVariantMap);
        
        if (!variant) {
          const identifier = record.sku || record.title || 'Unknown';
          console.log(`⚠️ No match found: ${identifier}`);
          this.skipped++;
          continue;
        }

        // Skip inactive products
        if (inactiveProducts.has(variant.product_id)) {
          console.log(`⏭️ Skipping inactive product: ${variant.product_title}`);
          this.skippedInactive++;
          continue;
        }

        // Build update object - only include fields that have values in CSV
        const updateData = { id: variant.id };
        let fieldsToUpdate = [];

        // Check weight (convert to grams if needed)
        if (record.weight || record.weight_grams) {
          const newWeight = parseFloat(record.weight_grams || record.weight);
          if (!isNaN(newWeight) && newWeight !== variant.weight) {
            updateData.weight = newWeight;
            updateData.weight_unit = 'g'; // Always use grams
            fieldsToUpdate.push('weight');
          }
        }

        // Check HS code
        const hsCode = record.hs_code || record.harmonized_code || record.tariff_code;
        if (hsCode && hsCode !== variant.harmonized_system_code) {
          updateData.harmonized_system_code = hsCode;
          fieldsToUpdate.push('hs_code');
        }

        // Check country of origin (expand 2-letter codes)
        const countryCode = record.country_of_origin || record.country;
        if (countryCode) {
          const expandedCountry = this.expandCountryCode(countryCode);
          if (expandedCountry !== variant.country_code_of_origin) {
            updateData.country_code_of_origin = expandedCountry;
            fieldsToUpdate.push('country');
          }
        }

        // Skip if nothing to update
        if (fieldsToUpdate.length === 0) {
          console.log(`✓ Already up to date: ${variant.product_title} - ${variant.title}`);
          this.skipped++;
          continue;
        }

        // Update variant
        try {
          await shopifyAPI.put(`/variants/${variant.id}.json`, {
            variant: updateData
          });

          this.updated++;
          console.log(`✅ Updated [${fieldsToUpdate.join(', ')}]: ${variant.product_title} - ${variant.title}`);
          
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
      console.log(`⏭️ Skipped (inactive): ${this.skippedInactive} variants`);
      console.log(`⚠️ Skipped (no changes/not found): ${this.skipped} items`);
      console.log(`❌ Errors: ${this.errors.length} variants`);
      console.log(`\nMatching stats:`);
      console.log(`  Matched by SKU: ${this.matchedBySku}`);
      console.log(`  Matched by title: ${this.matchedByTitle}`);

    } catch (error) {
      console.error('Fatal error:', error);
      throw error;
    }
  }

  expandCountryCode(code) {
    const countryMap = {
      'CA': 'CA', // Canada
      'US': 'US', // United States
      'CN': 'CN', // China
      'JP': 'JP', // Japan
      // Add more as needed
    };
    return countryMap[code.toUpperCase()] || code.toUpperCase();
  }

  async fetchAllProducts() {
    const variantsBySku = {};
    const productVariantMap = {};
    const inactiveProducts = new Set();
    let hasNextPage = true;
    let pageInfo = null;

    while (hasNextPage) {
      const query = pageInfo 
        ? `products.json?limit=250&page_info=${pageInfo}`
        : `products.json?limit=250`;

      const response = await shopifyAPI.get(query);
      
      response.data.products.forEach(product => {
        // Track inactive products
        if (product.status !== 'active') {
          inactiveProducts.add(product.id);
        }

        productVariantMap[product.title] = [];
        
        product.variants.forEach(variant => {
          variant.product_title = product.title;
          variant.product_id = product.id;
          
          if (variant.sku) {
            variantsBySku[variant.sku.trim().toUpperCase()] = variant;
          }
          
          productVariantMap[product.title].push(variant);
        });
      });

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

    return { variantsBySku, productVariantMap, inactiveProducts };
  }
}

module.exports = ShopifyCustomsUpdater;
