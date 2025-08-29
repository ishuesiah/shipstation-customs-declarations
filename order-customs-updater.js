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

/**
 * Toggle: append "SKU XYZ" to the customs description text so it’s visible
 * on the declarations, even though the UI’s dedicated SKU field is not settable
 * via API. This does NOT change your order items’ SKUs.
 */
const APPEND_SKU_TO_DESC = true;

/**
 * CATEGORY DICTIONARY (canonical -> customs fields)
 * – Edit here if you want to change the mapping.
 */
const CATEGORY_TO_CUSTOMS = {
  planners:        { hsCode: '4820.10.2010', description: 'Planner agenda (bound diary)', country: 'CA' },
  a5_notebooks:    { hsCode: '4820.10.2060', description: 'Notebook (bound journal)', country: 'CA' },
  b5_notebooks:    { hsCode: '4820.10.2030', description: 'Notebook (sewn journal, B5 size)', country: 'CA' },
  tn_notebooks:    { hsCode: '4820.10.2060', description: 'Notebook (bound journal)', country: 'CA' },
  planner_inserts: { hsCode: '4820.90.0000', description: 'Planner inserts (loose refills)', country: 'CA' },
  stickers:        { hsCode: '4911.99.8000', description: 'Paper sticker', country: 'CA' },
  washi_tape:      { hsCode: '4811.41.2100', description: 'Decorative paper tape for journaling', country: 'JP' },
  planner_charms:  { hsCode: '7117.90.9000', description: 'Imitation jewelry charm', country: 'CN' },
  planner_elastic: { hsCode: '6307.90.9800', description: 'Elastic for notebook', country: 'CN' },
  notepad:         { hsCode: '4820.10.2020', description: 'Notepad', country: 'CA' },
  sticky_notepad:  { hsCode: '4820.10.2020', description: 'Sticky notepad', country: 'USA' }
};

/**
 * Category synonyms → canonical key
 */
const CATEGORY_SYNONYMS = {
  '2025 planners': 'planners',
  '2026 planners hardcover': 'planners',
  '2026 planners cloth flex': 'planners',
  '2026 planners paper flex': 'planners',
  'undated planner': 'planners',
  'undated planners': 'planners',

  'a5 notebooks': 'a5_notebooks',
  'b5 notebooks': 'b5_notebooks',
  'tn notebooks': 'tn_notebooks',

  'planner inserts': 'planner_inserts',

  'stickers': 'stickers',
  'accessories washi tape': 'washi_tape',

  'planner charms': 'planner_charms',
  'planner elastic': 'planner_elastic',

  'notepads': 'notepad',
  'sticky notes': 'sticky_notepad'
};

/**
 * Name-based patterns (fallback)
 */
const NAME_PATTERNS = {
  planners: [
    /\b20(25|26)\b.*\bplanner(s)?\b/i,
    /\bundated\b.*\bplanner(s)?\b/i,
    /\b(daily|weekly|monthly)\b.*\bplanner(s)?\b/i,
    /\bplanner(s)?\b/i
  ],
  a5_notebooks:   [ /\ba5\b.*\b(notebook|journal)\b/i, /\b(notebook|journal)\b.*\ba5\b/i ],
  b5_notebooks:   [ /\bb5\b.*\b(notebook|journal)\b/i, /\b(notebook|journal)\b.*\bb5\b/i ],
  tn_notebooks:   [ /\btn\b.*\b(notebook|journal)\b/i, /\btravell?er'?s?\b.*\b(notebook|journal)\b/i ],
  planner_inserts:[ /\b(insert|inserts|refill|refills|loose|looseleaf)\b/i, /\bdisc\s*bound\b|\bdiscbound\b/i ],
  stickers:       [ /\b(sticker|stickers)\b/i, /\b(tab|tabs)\b/i, /\bhighlight(s)?\b/i ],
  washi_tape:     [ /\bwashi\b/i, /\bmt\b/i ],
  planner_charms: [ /\bcharm(s)?\b/i ],
  planner_elastic:[ /\belastic\b/i, /\bclip\s*band\b/i ],
  notepad:        [ /\bnotepad\b/i, /\bmemo\s*pad\b/i ],
  sticky_notepad: [ /\bsticky\s*note(s)?\b/i, /\bpost-?it\b/i, /\bstickies\b/i ]
};

class OrderCustomsUpdater {
  constructor() {
    this.updated = 0;
    this.skipped = 0;
    this.errors = [];
  }

  // ---------- helpers ----------
  normalize(text) {
    return (text || '')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeCategory(cat) {
    const n = this.normalize(cat);
    return CATEGORY_SYNONYMS[n] || n;
  }

  tokens(s) {
    const stop = new Set(['and','or','the','of','for','with','a','an','to','&']);
    return this.normalize(s).split(' ').filter(Boolean).filter(t => !stop.has(t));
  }

  overlapScore(a, b) {
    const A = new Set(this.tokens(a));
    const B = new Set(this.tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }

  scorePatternMatch(name, regex) {
    if (!name) return 0;
    const m = name.match(regex);
    if (!m) return 0;
    const base = 10;
    const lenBoost = Math.min((regex.source.length / 10), 10);
    return base + lenBoost;
  }

  customsFromDictEntry(entry) {
    return {
      harmonizedTariffCode: entry.hsCode,
      description: entry.description,
      countryOfOrigin: entry.country
    };
  }

  getCustomsByCategory(rawCategory) {
    if (!rawCategory) return null;
    const canonical = this.normalizeCategory(rawCategory);
    const entry = CATEGORY_TO_CUSTOMS[canonical];
    return entry ? this.customsFromDictEntry(entry) : null;
  }

  getCustomsByName(itemName) {
    if (!itemName) return null;
    let best = { cat: null, score: 0 };
    for (const [cat, patterns] of Object.entries(NAME_PATTERNS)) {
      let s = 0;
      for (const re of patterns) s += this.scorePatternMatch(itemName, re);
      if (s > best.score) best = { cat, score: s };
    }
    if (!best.cat) return null;
    const entry = CATEGORY_TO_CUSTOMS[best.cat];
    return entry ? this.customsFromDictEntry(entry) : null;
  }

  getCustomsData({ name, category }) {
    return this.getCustomsByCategory(category) || this.getCustomsByName(name) || null;
  }

  /** Format description, optionally appending the SKU text for human visibility. */
  formatDesc(base, sku) {
    if (!APPEND_SKU_TO_DESC || !sku) return base;
    // keep it readable; many carriers tolerate ~50–100 chars, tune if you need to
    const out = `${base} — SKU ${sku}`;
    return out.length > 100 ? out.slice(0, 100) : out;
  }

  /**
   * Find the best existing customs line to update (we prefer updating in place
   * to avoid duplicate lines).
   */
  findExistingLineIndex({ item, targetDesc, existing, usedIndices }) {
    // 1) Try match by SKU in description (some UIs carry it there)
    if (item.sku) {
      const skuNorm = this.normalize(item.sku);
      const idxSkuInDesc = existing.findIndex(
        (ci, i) => !usedIndices.has(i) && this.normalize(ci.description || '').includes(skuNorm)
      );
      if (idxSkuInDesc >= 0) return idxSkuInDesc;
    }

    // 2) Exact description match to target description
    if (targetDesc) {
      const idx2 = existing.findIndex(
        (ci, i) => !usedIndices.has(i) && this.normalize(ci.description) === this.normalize(targetDesc)
      );
      if (idx2 >= 0) return idx2;
    }

    // 3) Best token overlap with the item name
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < existing.length; i++) {
      if (usedIndices.has(i)) continue;
      const s = this.overlapScore(item.name || '', existing[i].description || '');
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    if (bestScore >= 0.34) return bestIdx;

    return -1;
  }

  /**
   * Merge customs items:
   *  - Start with ALL existing lines (so nothing is deleted)
   *  - Update best matches in place; else append new lines
   *  - We do NOT try to set a 'sku' on customs lines (the model doesn’t support it).
   */
  mergeCustomsItems(order) {
    const existing = Array.isArray(order.internationalOptions?.customsItems)
      ? order.internationalOptions.customsItems.map(ci => ({ ...ci }))
      : [];

    const used = new Set();
    const merged = existing.map(ci => ({ ...ci }));

    for (const item of order.items) {
      const match = this.getCustomsData({ name: item.name, category: item.category });
      if (!match) continue;

      const targetDesc = this.formatDesc(match.description, item.sku);
      const idx = this.findExistingLineIndex({ item, targetDesc, existing: merged, usedIndices: used });

      // Note: customs item model supports only these fields (no 'sku').
      const newLine = {
        ...(idx >= 0 && merged[idx].customsItemId ? { customsItemId: merged[idx].customsItemId } : {}),
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
        // avoid pushing an exact duplicate
        const dup = merged.findIndex(ci =>
          this.normalize(ci.description) === this.normalize(newLine.description) &&
          (ci.harmonizedTariffCode || '') === (newLine.harmonizedTariffCode || '') &&
          (ci.countryOfOrigin || '') === (newLine.countryOfOrigin || '') &&
          Number(ci.value || 0) === Number(newLine.value || 0) &&
          Number(ci.quantity || 0) === Number(newLine.quantity || 0)
        );
        if (dup === -1) merged.push(newLine);
      }
    }

    // Safety: never reduce customs lines
    if (merged.length < existing.length) {
      throw new Error(`Safety check: customs lines would decrease (${merged.length} < ${existing.length}). Aborting.`);
    }
    return merged;
  }

  /**
   * Build the items array in a way that *preserves SKUs* and avoids fields
   * that can cause ShipStation to remap products on us.
   */
  buildSafeItems(order) {
    const safe = order.items.map(it => ({
      orderItemId: it.orderItemId,
      lineItemKey: it.lineItemKey,
      sku: typeof it.sku === 'string' ? it.sku : (it.sku ?? ''), // keep exactly what ShipStation returned
      name: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      weight: it.weight,
      taxAmount: it.taxAmount
      // intentionally omit: fulfillmentSku, options, upc, productId, adjustment, imageUrl
    }));

    // Guard: no item that had a non-empty SKU should lose it
    const skuLoss = order.items.some((it, i) =>
      (it.sku && typeof it.sku === 'string' && it.sku.trim().length > 0) &&
      (!safe[i].sku || safe[i].sku.trim().length === 0)
    );
    if (skuLoss) throw new Error('Safety check: at least one line item would lose its SKU in the upsert payload. Aborting.');

    return safe;
  }

  makeUpsertPayload(order, customsItems) {
    const intl = order.internationalOptions || {};
    const items = this.buildSafeItems(order);

    return {
      // include both so we UPDATE the existing order
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

      items, // SKU-preserving

      advancedOptions: order.advancedOptions,
      tagIds: order.tagIds,

      // If we have lines, send merged lines; otherwise leave intl options untouched
      internationalOptions: customsItems.length
        ? { ...intl, contents: intl.contents || 'merchandise', customsItems }
        : intl
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

      console.log(`Found: ${order.orderNumber} → shipTo.country=${order.shipTo?.country}, orderKey=${order.orderKey}`);
      for (const item of order.items) console.log(`  - ${item.name} (SKU: ${item.sku})`);

      const customsItems = this.mergeCustomsItems(order);
      if (!customsItems.length) {
        console.log('⏭️ No customs changes to apply.');
        return;
      }

      const payload = this.makeUpsertPayload(order, customsItems);

      // Fingerprint includes SKU; if anything changes, abort.
      const fp = arr => arr.map(i => `${i.orderItemId}:${i.sku || ''}:${i.quantity}`).join('|');
      if (fp(order.items) !== fp(payload.items)) {
        throw new Error('Safety check failed: item lines would change (SKU and/or qty). Aborting.');
      }

      console.log(`Applying ${customsItems.length} customs line(s)...`);
      await shipstationAPI.post('/orders/createorder', payload);
      console.log(`✓ Upserted order ${orderNumber} with customs data.`);
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
    }
  }

  async updateOrders(options = {}) {
    const { countryCode = 'US', orderStatus = 'awaiting_shipment', startDate = null, endDate = null } = options;

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

          await new Promise(r => setTimeout(r, 600));
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
