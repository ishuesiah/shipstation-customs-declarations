'use strict';

const axios = require('axios');

class ShipStationAPI {
  constructor() {
    this.key = process.env.SHIPSTATION_API_KEY;
    this.secret = process.env.SHIPSTATION_API_SECRET;
    if (!this.key || !this.secret) {
      throw new Error('Missing ShipStation credentials. Set SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET in .env');
    }
    this.client = axios.create({
      baseURL: 'https://ssapi.shipstation.com',
      headers: { 'Content-Type': 'application/json' },
      auth: { username: this.key, password: this.secret }
    });
  }

  // Helper for retry logic on rate limits
  async retryWithBackoff(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (err.response?.status === 429 && i < maxRetries - 1) {
          const backoff = Math.pow(2, i) * 2000; // 2s, 4s, 8s
          console.log(`Rate limited, waiting ${backoff}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          throw err;
        }
      }
    }
  }

  // ===== Orders =====
  async getOrder(orderId) {
    return this.retryWithBackoff(async () => {
      const { data } = await this.client.get(`/orders/${encodeURIComponent(orderId)}`);
      return data;
    });
  }

  // Create or Update an order. If body contains orderId, it updates that order in-place.
  async createOrUpdateOrder(orderBody) {
    const { data } = await this.client.post('/orders/createorder', orderBody);
    return data;
  }

  // Robust list/search that tolerates different shapes {orders|results|items|[]}
  async searchOrders(params = {}) {
    const { data } = await this.client.get('/orders', { params });
    const list =
      Array.isArray(data?.orders) ? data.orders :
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data?.items)   ? data.items   :
      Array.isArray(data)          ? data         : [];
    return list;
  }

  async getOrderByNumber(orderNumber) {
    const list = await this.searchOrders({ orderNumber: String(orderNumber) });
    return list[0] || null;
  }

  async getOrderByKey(orderKey) {
    const list = await this.searchOrders({ orderKey: String(orderKey) });
    return list[0] || null;
  }

  // ===== Products =====
  async getProductById(productId) {
    const { data } = await this.client.get(`/products/${encodeURIComponent(productId)}`);
    return data;
  }

  async searchProductsByName(name, pageSize = 200, maxPages = 5) {
    const q = String(name || '').trim();
    if (!q) return [];
    const results = [];
    let page = 1;

    while (page <= maxPages) {
      const { data } = await this.client.get('/products', { params: { name: q, page, pageSize } });
      const items =
        Array.isArray(data)            ? data :
        Array.isArray(data?.products)  ? data.products :
        Array.isArray(data?.items)     ? data.items :
        Array.isArray(data?.results)   ? data.results :
        [];
      if (!items.length) break;
      results.push(...items);
      if (items.length < pageSize) break;
      page += 1;
    }
    return results;
  }
}

module.exports = { ShipStationAPI };