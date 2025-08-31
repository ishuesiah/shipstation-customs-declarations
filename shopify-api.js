// shopify-api.js
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

class ShopifyAPI {
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

    // Shopify REST: ~2 rps; keep it gentle
    this.lastRequestTime = 0;
    this.minRequestInterval = 550;
  }

  async rateLimit() {
    const now = Date.now();
    const gap = now - this.lastRequestTime;
    if (gap < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - gap));
    }
    this.lastRequestTime = Date.now();
  }

  // -------- Fetch products (raw) -------------------------------------------
  async getAllProducts(status = 'active') {
    const products = [];
    let hasNextPage = true;
    let pageInfo = null;
    let pageCount = 0;

    while (hasNextPage) {
      await this.rateLimit();
      const query = pageInfo
        ? `products.json?limit=250&page_info=${pageInfo}`
        : `products.json?limit=250&status=${status}`;

      const response = await this.client.get(query);
      products.push(...response.data.products);
      pageCount++;

      const linkHeader = response.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>]+)>; rel="next"/);
        pageInfo = match ? match[1] : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }
    }

    return products;
  }

  // -------- Hydrate InventoryItem fields onto variants ----------------------
  async getAllProductsWithInventory(status = 'active') {
    const products = await this.getAllProducts(status);
    await this.attachInventoryFields(products);
    return products;
  }

  async attachInventoryFields(products) {
    // Collect unique inventory_item_ids
    const ids = [];
    products.forEach(p => p.variants.forEach(v => {
      if (v.inventory_item_id) ids.push(v.inventory_item_id);
    }));
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;

    // Bulk fetch in chunks of 50 (safe for REST)
    const invMap = new Map();
    const chunkSize = 50;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const slice = uniqueIds.slice(i, i + chunkSize);
      await this.rateLimit();
      const resp = await this.client.get('/inventory_items.json', {
        params: { ids: slice.join(',') }
      });
      const items = resp.data.inventory_items || [];
      items.forEach(it => invMap.set(it.id, it));
    }

    // Attach to variants so UI can read them
    products.forEach(p => p.variants.forEach(v => {
      const it = invMap.get(v.inventory_item_id);
      if (it) {
        v.harmonized_system_code = it.harmonized_system_code || '';
        // Shopify field name is country_code_of_origin
        v.country_code_of_origin = it.country_code_of_origin || it.country_of_origin || '';
      } else {
        v.harmonized_system_code = v.harmonized_system_code || '';
        v.country_code_of_origin = v.country_code_of_origin || '';
      }
    }));
  }

  // -------- Update variants + inventory items -------------------------------
  async updateVariants(updates) {
    const results = { updated: 0, failed: 0, errors: [] };

    for (const update of updates) {
      await this.rateLimit();

      try {
        const { id, sku, price, weight, harmonized_system_code, country_code_of_origin, ...rest } = update;

        const needsVariantUpdate = (sku !== undefined) || (price !== undefined) || (weight !== undefined) || Object.keys(rest).length > 0;
        const needsInventoryUpdate = (harmonized_system_code !== undefined) || (country_code_of_origin !== undefined);

        // 1) Variant update (SKU/price/weight etc.)
        if (needsVariantUpdate) {
          const payload = { variant: { id } };
          if (sku !== undefined) payload.variant.sku = sku;
          if (price !== undefined) payload.variant.price = parseFloat(price);
          if (weight !== undefined) {
            payload.variant.weight = parseFloat(weight);
            payload.variant.weight_unit = 'g';
          }
          // pass-through any other allowed variant fields
          Object.assign(payload.variant, rest);

          await this.client.put(`/variants/${id}.json`, payload);
        }

        // 2) Inventory item update (HS code / country of origin)
        if (needsInventoryUpdate) {
          // We need the inventory_item_id for the variant
          await this.rateLimit();
          const vResp = await this.client.get(`/variants/${id}.json`);
          const inventoryItemId = vResp.data?.variant?.inventory_item_id;
          if (!inventoryItemId) throw new Error(`No inventory_item_id for variant ${id}`);

          const invPayload = { inventory_item: { id: inventoryItemId } };
          if (harmonized_system_code !== undefined) invPayload.inventory_item.harmonized_system_code = harmonized_system_code || '';
          if (country_code_of_origin !== undefined) invPayload.inventory_item.country_code_of_origin = country_code_of_origin || '';

          await this.rateLimit();
          await this.client.put(`/inventory_items/${inventoryItemId}.json`, invPayload);
        }

        // Count once per update object
        results.updated++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          variantId: update.id,
          error: error.response?.data?.errors || error.message
        });
      }
    }

    return results;
  }

  // Convenience helpers (kept from your file)
  async getProduct(productId) {
    await this.rateLimit();
    const response = await this.client.get(`/products/${productId}.json`);
    return response.data.product;
  }

  async getVariant(variantId) {
    await this.rateLimit();
    const response = await this.client.get(`/variants/${variantId}.json`);
    return response.data.variant;
  }

  async validateSKUs(products = null) {
    if (!products) products = await this.getAllProducts();
    const skuMap = new Map();
    const duplicates = [];
    const missing = [];

    products.forEach(product => {
      product.variants.forEach(variant => {
        const key = `${product.title} - ${variant.title || 'Default'}`;
        if (!variant.sku || variant.sku.trim() === '') {
          missing.push({ product: product.title, variant: variant.title || 'Default', id: variant.id });
        } else {
          const sku = variant.sku.trim().toUpperCase();
          if (skuMap.has(sku)) duplicates.push({ sku, products: [skuMap.get(sku), key] });
          else skuMap.set(sku, key);
        }
      });
    });

    return {
      total: products.reduce((sum, p) => sum + p.variants.length, 0),
      unique: skuMap.size,
      duplicates,
      missing
    };
  }
}

module.exports = { ShopifyAPI };
