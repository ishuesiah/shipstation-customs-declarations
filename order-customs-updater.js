// order-customs-updater.js
const axios = require('axios');
require('dotenv').config();

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;

const shipstationAPI = axios.create({
  baseURL: 'https://ssapi.shipstation.com',
  auth: { username: SHIPSTATION_API_KEY, password: SHIPSTATION_API_SECRET },
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000
});

class OrderCustomsUpdater {
  constructor() {
    this.updated = 0;
    this.skipped = 0;
    this.errors = [];

    // Rules for mapping item names -> customs data
this.rules = [
      { keywords: ['insert', 'inserts'], hsCode: '4820.90.0000', description: 'Planner inserts (loose refills)', country: 'CA' },
      { keywords: ['2026 planner', '2025 planner', 'undated planner', 'daily planner', 'weekly planner',], hsCode: '4820.10.2010', description: 'Planner agenda (bound diary)', country: 'CA' },
      { keywords: ['b5 notebook'], hsCode: '4820.10.2030', description: 'Notebook (sewn journal, B5 size)', country: 'CA' },
      { keywords: ['a5 notebook', 'tn notebook', 'dotted notebook'], hsCode: '4820.10.2060', description: 'Notebook (bound journal)', country: 'CA' },
      { keywords: ['notepad', 'weekly habit tracker notepad'], hsCode: '4820.10.2020', description: 'Notepad', country: 'CA' },
      { keywords: ['sticky note', 'stickies'], hsCode: '4820.10.2020', description: 'Sticky notepad', country: 'USA' },
      { keywords: ['sticker', 'tabs', 'monthly tabs', 'highlight', 'stickers', 'square bullet', 'time management', 'wellness'], hsCode: '4911.99.8000', description: 'Paper sticker', country: 'CA' },
      { keywords: ['pen', 'brass', 'aluminum'], hsCode: '9608.10.0000', description: 'Gel ink pen', country: 'CA' },
      { keywords: ['pen refill', 'ink refill', 'refill'], hsCode: '9608.60.0000', description: 'Refills for ballpoint pen', country: 'JP' },
      { keywords: ['bracelet'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery bracelets', country: 'CA' },
      { keywords: ['earring', 'earrings'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery earrings', country: 'CA' },
      { keywords: ['pendant', 'necklace'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery pendants', country: 'CA' },
      { keywords: ['stud', 'studs'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery studs', country: 'CA' },
      { keywords: ['paper clip', 'paperclip'], hsCode: '8305.90.3010', description: 'Office paper clips', country: 'CN' },
      { keywords: ['elastic band', 'clip band elastic'], hsCode: '6307.90.9800', description: 'Elastic for notebook', country: 'CN' },
      { keywords: ['planner charm', 'charms', 'ribbon charm'], hsCode: '7117.90.9000', description: 'Charm for notebook ribbon', country: 'CN' },
      { keywords: ['planner pocket'], hsCode: '4811.41.2100', description: 'Paper pocket for notebook', country: 'CN' },
      { keywords: ['washi', 'mt'], hsCode: '4811.41.2100', description: 'Decorative tape for journaling', country: 'JP' }
    ];
  }

  // --- helpers ---------------------------------------------------------------

  normalize(s) {
    return (s || '')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tokens(s) {
    const stop = new Set(['and','or','the','of','for','with','a','an','to','&']);
    return this.normalize(s)
      .split(' ')
      .filter(Boolean)
      .filter(t => !stop.has(t));
  }

  overlapScore(nameA, nameB) {
    // Jaccard over item-name tokens vs description tokens, small but useful
    const A = new Set(this.tokens(nameA));
    const B = new Set(this.tokens(nameB));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }

  // Map name -> customs fields (case-insensitive keywords)
  getCustomsData(productName) {
    if (!productName) return null;
    const nameLower = productName.toLowerCase();
    for (const rule of this.rules) {
      for (const keyword of rule.keywords) {
        if (nameLower.includes(keyword)) {
          return {
            harmonizedTariffCode: rule.hsCode,
            description: rule.description,
            countryOfOrigin: rule.country
          };
        }
      }
    }
    return null;
  }

  // Find the best existing customs line to update, WITHOUT requiring SKU.
  // Cascade: SKU match -> exact description match (target description) -> highest token overlap.
  findExistingLineIndex({ item, targetDesc, existing, usedIndices }) {
    // 1) SKU
    if (item.sku) {
      const idx = existing.findIndex(
        (ci, i) => !usedIndices.has(i) && ci.sku && this.normalize(ci.sku) === this.normalize(item.sku)
      );
      if (idx >= 0) return idx;
    }

    // 2) Exact description (case-insensitive) match to target description
    if (targetDesc) {
      const idx = existing.findIndex(
        (ci, i) => !usedIndices.has(i) && this.normalize(ci.description) === this.normalize(targetDesc)
      );
      if (idx >= 0) return idx;
    }

    // 3) Best token overlap with item name
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < existing.length; i++) {
      if (usedIndices.has(i)) continue;
      const s = this.overlapScore(item.name || '', existing[i].description || '');
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    // Only accept a "fuzzy" match if there's some signal
    if (bestScore >= 0.34) return bestIdx; // tweakable threshold

    return -1;
  }

  // Build a merged customsItems array:
  // - Start with ALL existing lines (so nothing is deleted)
  // - For each item that matches a rule, update the "best" existing line if found; else append a new line.
  // - When appending, set sku so future runs can map reliably.
  mergeCustomsItems(order) {
    const existing = Array.isArray(order.internationalOptions?.customsItems)
      ? order.internationalOptions.customsItems.map(ci => ({ ...ci }))
      : [];

    const used = new Set(); // indices in `existing` we've already updated
    const merged = existing.map(ci => ({ ...ci })); // copy to avoid mutations of original

    for (const item of order.items) {
      const match = this.getCustomsData(item.name);
      if (!match) continue;

      const targetDesc = match.description;
      const idx = this.findExistingLineIndex({
        item,
        targetDesc,
        existing: merged,
        usedIndices: used
      });

      const newLine = {
        // keep id if updating an existing line
        ...(idx >= 0 && merged[idx].customsItemId ? { customsItemId: merged[idx].customsItemId } : {}),
        // set SKU for future deterministic matching (even if the existing line lacked one)
        sku: item.sku || (idx >= 0 ? merged[idx].sku : undefined),
        description: targetDesc,
        quantity: idx >= 0 ? (merged[idx].quantity || item.quantity || 1) : (item.quantity || 1),
        value: Number(((item.unitPrice || merged[idx]?.value || 0) * (item.quantity || 1)).toFixed(2)),
        harmonizedTariffCode: match.harmonizedTariffCode,
        countryOfOrigin: match.countryOfOrigin
      };

      if (idx >= 0) {
        merged[idx] = newLine;
        used.add(idx);
      } else {
        // Avoid adding an identical duplicate (same desc/hts/coo/sku/qty/value)
        const dup = merged.findIndex(ci =>
          this.normalize(ci.description) === this.normalize(newLine.description) &&
          (ci.harmonizedTariffCode || '') === (newLine.harmonizedTariffCode || '') &&
          (ci.countryOfOrigin || '') === (newLine.countryOfOrigin || '') &&
          (this.normalize(ci.sku || '') === this.normalize(newLine.sku || '')) &&
          Number(ci.value || 0) === Number(newLine.value || 0) &&
          Number(ci.quantity || 0) === Number(newLine.quantity || 0)
        );
        if (dup === -1) merged.push(newLine);
      }
    }

    return merged;
  }

  // Build the full upsert payload (no partial updates allowed).
  makeUpsertPayload(order, customsItems) {
    const intl = order.internationalOptions || {};
    return {
      // Include both orderId + orderKey to ensure UPDATE (not create)
      orderId: order.orderId,
      orderKey: order.orderKey,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      orderStatus: order.orderStatus,
      customerUsername: order.customerUsername,
      customerEmail: order.customerEmail,
      billTo: order.billTo,
      shipTo: order.shipTo,
      amountPaid: order.amountPaid,
      taxAmount: order.taxAmount,
      shippingAmount: order.shippingAmount,
      orderTotal: order.orderTotal,

      items: order.items.map(it => ({
        orderItemId: it.orderItemId,
        lineItemKey: it.lineItemKey,
        sku: it.sku,
        name: it.name,
        imageUrl: it.imageUrl,
        weight: it.weight,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        options: it.options,
        productId: it.productId,
        fulfillmentSku: it.fulfillmentSku,
        adjustment: it.adjustment,
        upc: it.upc,
        taxAmount: it.taxAmount
      })),

      advancedOptions: order.advancedOptions,
      tagIds: order.tagIds,

      internationalOptions: customsItems.length
        ? { ...intl, contents: intl.contents || 'merchandise', customsItems }
        : intl // if empty, leave exactly as-is (prevents wiping)
    };
  }

  async updateSingleOrder(orderNumber) {
    console.log('========================================');
    console.log(`TESTING CUSTOMS UPDATE ON ORDER ${orderNumber}`);
    console.log('========================================\n');

    try {
      console.log(`Fetching order ${orderNumber}...`);
      const resp = await shipstationAPI.get('/orders', { params: { orderNumber } });

      if (!resp.data.orders || resp.data.orders.length === 0) {
        console.log(`✗ Order ${orderNumber} not found`);
        return;
      }

      const order = resp.data.orders[0];
      if (order.orderStatus !== 'awaiting_shipment') {
        console.log(`✗ Order ${orderNumber} is not editable (status: ${order.orderStatus})`);
        return;
      }

      console.log(`Found order: ${order.orderNumber} → shipTo.country=${order.shipTo?.country}, orderKey=${order.orderKey}`);
      console.log('Current items:');
      for (const item of order.items) {
        console.log(`  - ${item.name} (SKU: ${item.sku})`);
      }

      const customsItems = this.mergeCustomsItems(order);
      if (!customsItems.length) {
        console.log('⏭️ No customs changes to apply.');
        return;
      }

      console.log(`Applying ${customsItems.length} customs line(s)...`);
      const payload = this.makeUpsertPayload(order, customsItems);

      // Safety: ensure we didn’t change item lines
      const fp = arr => arr.map(i => `${i.orderItemId}:${i.sku}:${i.quantity}`).join('|');
      if (fp(order.items) !== fp(payload.items)) {
        throw new Error('Safety check failed: item lines would change. Aborting.');
      }

      await shipstationAPI.post('/orders/createorder', payload);
      console.log(`✓ Upserted order ${orderNumber} with customs data.`);
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
    }
  }

  async updateOrders(options = {}) {
    const {
      countryCode = 'US',
      orderStatus = 'awaiting_shipment',
      startDate = null,
      endDate = null
    } = options;

    console.log('========================================');
    console.log('UPDATING ORDER CUSTOMS DATA (BULK)');
    console.log('========================================\n');
    console.log(`Target country: ${countryCode}`);
    console.log(`Order status: ${orderStatus}\n`);

    try {
      let page = 1;
      const pageSize = 100;
      let totalOrders = 0;

      while (true) {
        const params = { page, pageSize, orderStatus };
        if (startDate) params.createDateStart = startDate;
        if (endDate) params.createDateEnd = endDate;

        console.log(`Fetching page ${page}...`);
        const resp = await shipstationAPI.get('/orders', { params });
        const orders = resp.data.orders || [];
        if (orders.length === 0) break;

        totalOrders += orders.length;

        for (const order of orders) {
          if (order.shipTo?.country !== countryCode) { this.skipped++; continue; }
          if (order.orderStatus !== 'awaiting_shipment') { this.skipped++; continue; }

          const customsItems = this.mergeCustomsItems(order);
          if (!customsItems.length) { this.skipped++; continue; }

          try {
            const payload = this.makeUpsertPayload(order, customsItems);
            await shipstationAPI.post('/orders/createorder', payload);
            this.updated++;
            console.log(`✓ Updated ${order.orderNumber} (${customsItems.length} customs line(s))`);
          } catch (e) {
            const err = e.response?.data || e.message;
            this.errors.push({ order: order.orderNumber, error: err });
            console.error(`✗ Failed ${order.orderNumber}:`, err);
          }

          await new Promise(r => setTimeout(r, 600)); // simple rate limit
        }

        page++;
        await new Promise(r => setTimeout(r, 1000));
      }

      console.log('\n========================================');
      console.log('ORDER CUSTOMS UPDATE COMPLETE');
      console.log('========================================');
      console.log(`Total orders processed: ${totalOrders}`);
      console.log(`Updated: ${this.updated}`);
      console.log(`Skipped: ${this.skipped}`);
      console.log(`Errors: ${this.errors.length}`);
      if (this.errors.length) {
        for (const e of this.errors) console.log(`- ${e.order}: ${JSON.stringify(e.error)}`);
      }
    } catch (fatal) {
      console.error('Fatal error:', fatal);
      throw fatal;
    }
  }
}

module.exports = OrderCustomsUpdater;
