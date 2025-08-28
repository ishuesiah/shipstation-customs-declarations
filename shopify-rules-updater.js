const axios = require('axios');
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

class ShopifyRulesUpdater {
  constructor() {
    this.updated = 0;
    this.errors = [];
    this.skipped = 0;
  }

  getHSCodeAndCountry(productTitle) {
    const title = productTitle.toLowerCase();
    
    // Check inserts FIRST (before notebook, since inserts can have A5 in variant)
    if (title.includes('insert')) {  // This catches both "insert" and "inserts"
      return { hsCode: '4820.90.0000', country: 'CA' };
    }
    
    // Then check other specific rules
    if (title.includes('washi')) {
      return { hsCode: '4811.41.2100', country: 'JP' };
    }
    if (title.includes('refill')) {
      return { hsCode: '9608.60.00', country: 'JP' };
    }
    if (title.includes('paper clips')) {
      return { hsCode: '8305.90.3010', country: 'CN' };
    }
    if (title.includes('elastic')) {
      return { hsCode: '6307.90.98', country: 'CN' };
    }
    if (title.includes('charm')) {
      return { hsCode: '7117.90.90', country: 'CN' };
    }
    if (title.includes('pocket')) {
      return { hsCode: '4811.41.2100', country: 'CN' };
    }
    if (title.includes('sticky') || title.includes('stickies')) {
      return { hsCode: '4820.10.2020', country: 'US' };
    }
    if (title.includes('earring') || title.includes('stud') || title.includes('bracelet')) {
      return { hsCode: '7113.11.5000', country: 'CA' };
    }
    if (title.includes('notepad') || title.includes('tracker')) {
      return { hsCode: '4820.10.2020', country: 'CA' };
    }
    if (title.includes('brass') || title.includes('pen')) {
      return { hsCode: '9608.10.0000', country: 'CA' };
    }
    if (title.includes('planner')) {
      return { hsCode: '4820.10.2010', country: 'CA' };
    }
    if (title.includes('notebook')) {
      // Default notebook HS code - will be refined by variant
      return { hsCode: '4820.10.2060', country: 'CA' };
    }
    
    return null;
  }

  getSpecialHSCode(productTitle, variant) {
    const title = productTitle.toLowerCase();
    
    // IMPORTANT: Check for inserts first - they override notebook logic
    if (title.includes('insert')) {
      return '4820.90.0000';  // All inserts get this code regardless of variant
    }
    
    // Only apply notebook variant logic if it's actually a notebook
    if (title.includes('notebook')) {
      // Combine all variant options into one string to check
      const variantText = [
        variant.option1 || '',
        variant.option2 || '',
        variant.option3 || ''
      ].join(' ').toLowerCase();
      
      // Check for size in variant options
      if (variantText.includes('b5')) {
        return '4820.10.2030';
      }
      if (variantText.includes('a5') || variantText.includes('tn')) {
        return '4820.10.2060';
      }
      
      // Default notebook code
      return '4820.10.2060';
    }
    
    return null;
  }

  getWeight(productTitle, variant) {
    const title = productTitle.toLowerCase();
    
    // Combine variant options for checking
    const variantText = [
      variant.option1 || '',
      variant.option2 || '',
      variant.option3 || ''
    ].join(' ').toLowerCase();
    
    // Simple products first
    if (title.includes('washi')) return 15;
    if (title.includes('sticker')) return 3;
    if (title.includes('charm')) return 5;
    if (title.includes('elastic')) return 10;
    
    // 2026 planners
    if (title.includes('2026')) {
      if (title.includes('weekly & daily') && title.includes('70 gsm')) {
        return 800;
      }
      if (title.includes('daily')) {
        if (title.includes('hardcover')) return 1008;
        if (title.includes('cloth flex')) return 908;
        if (title.includes('paper flex')) return 920;
      }
      if (title.includes('vertical') || title.includes('horizontal')) {
        if (title.includes('hardcover')) return 610;
        if (title.includes('cloth flex')) return 492;
        if (title.includes('paper flex')) return 504;
      }
    }
    
    // Notebooks - complex rules
    if (title.includes('notebook')) {
      // Cloth flex notebooks
      if (title.includes('cloth flex') && !title.includes('hardcover') && !title.includes('paper flex')) {
        if (variantText.includes('a5')) return 394;
      }
      
      // Paper flex notebooks
      if (title.includes('paper flex') && !title.includes('hardcover') && !title.includes('cloth flex')) {
        if (variantText.includes('a5')) return 404;
      }
      
      // Regular notebooks (exclude 70gsm and flex variants)
      if (!title.includes('70gsm') && !title.includes('70 gsm') && 
          !title.includes('cloth flex') && !title.includes('paper flex')) {
        if (variantText.includes('tn')) return 372;
        if (variantText.includes('a5')) return 498;
        if (variantText.includes('b5')) return 706;
      }
    }
    
    return null;
  }

  async applyRules() {
    console.log('========================================');
    console.log('APPLYING RULES TO SHOPIFY PRODUCTS');
    console.log('========================================\n');

    try {
      console.log('Fetching all Shopify products...');
      let hasNextPage = true;
      let pageInfo = null;
      let processedCount = 0;

      while (hasNextPage) {
        const query = pageInfo 
          ? `products.json?limit=250&page_info=${pageInfo}`
          : `products.json?limit=250`;

        const response = await shopifyAPI.get(query);
        
        for (const product of response.data.products) {
          // Skip inactive products
          if (product.status !== 'active') continue;
          
          processedCount++;
          
          // Get base HS code and country for this product
          const productRules = this.getHSCodeAndCountry(product.title);
          
          for (const variant of product.variants) {
            const updateData = { id: variant.id };
            let fieldsToUpdate = [];
            
            // Determine HS code - check for special cases (notebooks with variants, inserts)
            let hsCode = null;
            if (product.title.toLowerCase().includes('notebook') || 
                product.title.toLowerCase().includes('insert')) {
              // Use special logic for notebooks and inserts
              hsCode = this.getSpecialHSCode(product.title, variant);
            } 
            
            // If no special case applied, use the general rules
            if (!hsCode && productRules) {
              hsCode = productRules.hsCode;
            }
            
            // Update HS code if different
            if (hsCode && hsCode !== variant.harmonized_system_code) {
              updateData.harmonized_system_code = hsCode;
              fieldsToUpdate.push(`hs_code: ${hsCode}`);
            }
            
            // Update country if different
            if (productRules && productRules.country !== variant.country_code_of_origin) {
              updateData.country_code_of_origin = productRules.country;
              fieldsToUpdate.push(`country: ${productRules.country}`);
            }
            
            // Calculate weight
            const weight = this.getWeight(product.title, variant);
            if (weight && weight !== variant.weight) {
              updateData.weight = weight;
              updateData.weight_unit = 'g';
              fieldsToUpdate.push(`weight: ${weight}g`);
            }
            
            // Skip if nothing to update
            if (fieldsToUpdate.length === 0) {
              continue;
            }
            
            // Update variant
            try {
              await shopifyAPI.put(`/variants/${variant.id}.json`, {
                variant: updateData
              });
              
              this.updated++;
              const variantName = [variant.option1, variant.option2, variant.option3]
                .filter(Boolean)
                .join(' / ');
              console.log(`✅ Updated [${fieldsToUpdate.join(', ')}]: ${product.title} - ${variantName}`);
              
              await new Promise(resolve => setTimeout(resolve, 550));
              
            } catch (error) {
              this.errors.push({
                product: `${product.title} - ${[variant.option1, variant.option2, variant.option3].filter(Boolean).join(' / ')}`,
                error: error.response?.data || error.message
              });
              console.error(`❌ Failed: ${product.title} - ${error.response?.data?.errors || error.message}`);
            }
          }
        }

        // Check for next page
        const linkHeader = response.headers['link'];
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const match = linkHeader.match(/page_info=([^>]+)>; rel="next"/);
          pageInfo = match ? match[1] : null;
          hasNextPage = !!pageInfo;
        } else {
          hasNextPage = false;
        }

        console.log(`Processed ${processedCount} products so far...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log('\n========================================');
      console.log('RULES APPLICATION COMPLETE');
      console.log('========================================');
      console.log(`✅ Updated: ${this.updated} variants`);
      console.log(`❌ Errors: ${this.errors.length}`);
      console.log(`📊 Total products processed: ${processedCount}`);

    } catch (error) {
      console.error('Fatal error:', error);
      throw error;
    }
  }
}

module.exports = ShopifyRulesUpdater;
