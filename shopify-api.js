// shopify-api.js - Clean Shopify API wrapper
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export class ShopifyAPI {
  constructor() {
    this.store = process.env.SHOPIFY_STORE;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = '2024-01';
    
    if (!this.store || !this.accessToken) {
      throw new Error('Missing Shopify credentials in .env file');
    }
    
    this.client = axios.create({
      baseURL: `https://${this.store}/admin/api/${this.apiVersion}`,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json'
      }
    });
    
    // Rate limiting: Shopify allows 2 requests per second
    this.lastRequestTime = 0;
    this.minRequestInterval = 550; // milliseconds between requests
  }
  
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const delay = this.minRequestInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.lastRequestTime = Date.now();
  }
  
  async getAllProducts(status = 'active') {
    const products = [];
    let hasNextPage = true;
    let pageInfo = null;
    let pageCount = 0;
    
    console.log(`Fetching ${status} products from Shopify...`);
    
    while (hasNextPage) {
      await this.rateLimit();
      
      const query = pageInfo 
        ? `products.json?limit=250&page_info=${pageInfo}`
        : `products.json?limit=250&status=${status}`;
      
      try {
        const response = await this.client.get(query);
        
        products.push(...response.data.products);
        pageCount++;
        
        console.log(`  Page ${pageCount}: ${response.data.products.length} products`);
        
        // Check for next page
        const linkHeader = response.headers['link'];
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const match = linkHeader.match(/page_info=([^>]+)>; rel="next"/);
          pageInfo = match ? match[1] : null;
          hasNextPage = !!pageInfo;
        } else {
          hasNextPage = false;
        }
        
      } catch (error) {
        console.error('Error fetching products:', error.response?.data || error.message);
        throw error;
      }
    }
    
    console.log(`Total: ${products.length} products fetched\n`);
    return products;
  }
  
  async updateVariants(updates) {
    const results = {
      updated: 0,
      failed: 0,
      errors: []
    };
    
    console.log(`Updating ${updates.length} variants...`);
    
    for (const update of updates) {
      await this.rateLimit();
      
      try {
        const { id, ...fields } = update;
        
        // Build the update payload - Shopify variant update structure
        const updatePayload = {
          variant: {
            id: id,
            ...fields
          }
        };
        
        // Special handling for weight - ensure it's a number and in grams
        if (fields.weight !== undefined) {
          updatePayload.variant.weight = parseFloat(fields.weight);
          updatePayload.variant.weight_unit = 'g';
        }
        
        // Ensure price is a number
        if (fields.price !== undefined) {
          updatePayload.variant.price = parseFloat(fields.price);
        }
        
        await this.client.put(`/variants/${id}.json`, updatePayload);
        
        results.updated++;
        console.log(`  ✓ Updated variant ${id}`);
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          variantId: update.id,
          error: error.response?.data?.errors || error.message
        });
        
        console.error(`  ✗ Failed to update variant ${update.id}:`, 
                     error.response?.data?.errors || error.message);
      }
    }
    
    console.log(`Update complete: ${results.updated} succeeded, ${results.failed} failed\n`);
    return results;
  }
  
  async getProduct(productId) {
    await this.rateLimit();
    
    try {
      const response = await this.client.get(`/products/${productId}.json`);
      return response.data.product;
    } catch (error) {
      console.error('Error fetching product:', error.response?.data || error.message);
      throw error;
    }
  }
  
  async getVariant(variantId) {
    await this.rateLimit();
    
    try {
      const response = await this.client.get(`/variants/${variantId}.json`);
      return response.data.variant;
    } catch (error) {
      console.error('Error fetching variant:', error.response?.data || error.message);
      throw error;
    }
  }
  
  // Utility method to check for SKU uniqueness
  async validateSKUs(products = null) {
    if (!products) {
      products = await this.getAllProducts();
    }
    
    const skuMap = new Map();
    const duplicates = [];
    const missing = [];
    
    products.forEach(product => {
      product.variants.forEach(variant => {
        const key = `${product.title} - ${variant.title || 'Default'}`;
        
        if (!variant.sku || variant.sku.trim() === '') {
          missing.push({
            product: product.title,
            variant: variant.title || 'Default',
            id: variant.id
          });
        } else {
          const sku = variant.sku.trim().toUpperCase();
          
          if (skuMap.has(sku)) {
            duplicates.push({
              sku: sku,
              products: [skuMap.get(sku), key]
            });
          } else {
            skuMap.set(sku, key);
          }
        }
      });
    });
    
    return {
      total: products.reduce((sum, p) => sum + p.variants.length, 0),
      unique: skuMap.size,
      duplicates: duplicates,
      missing: missing
    };
  }
}