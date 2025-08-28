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
      { keywords: ['insert', 'refill', 'loose', 'pages only'], hsCode: '4820.90.0000', description: 'Planner inserts (loose refills)', country: 'CA' },
      { keywords: ['2026 planner', '2025 planner', 'undated planner', 'daily planner', 'weekly planner', 'monthly planner'], hsCode: '4820.10.2010', description: 'Planner agenda (bound diary)', country: 'CA' },
      { keywords: ['b5 notebook', 'b5 journal', 'notebook b5', 'journal b5'], hsCode: '4820.10.2030', description: 'Notebook (sewn journal, B5 size)', country: 'CA' },
      { keywords: ['a5 notebook', 'tn notebook', 'travelers notebook', 'notebook a5', 'journal a5', 'dotted notebook', 'lined notebook', 'grid notebook', 'blank notebook'], hsCode: '4820.10.2060', description: 'Notebook (bound journal)', country: 'CA' },
      { keywords: ['notebook', 'journal'], hsCode: '4820.10.2060', description: 'Notebook (bound journal)', country: 'CA' },
      { keywords: ['notepad', 'note pad', 'memo pad', 'writing pad'], hsCode: '4820.10.2020', description: 'Notepad', country: 'CA' },
      { keywords: ['sticky note', 'sticky pad', 'post-it', 'adhesive note'], hsCode: '4820.10.2020', description: 'Sticky notepad', country: 'USA' },
      { keywords: ['sticker', 'decal', 'label'], hsCode: '4911.99.8000', description: 'Paper sticker', country: 'CA' },
      { keywords: ['pen', 'gel pen', 'ballpoint', 'rollerball', 'fountain pen'], hsCode: '9608.10.0000', description: 'Gel ink pen', country: 'CA' },
      { keywords: ['pen refill', 'ink refill', 'cartridge'], hsCode: '9608.60.0000', description: 'Refills for ballpoint pen', country: 'JP' },
      { keywords: ['bracelet'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery bracelets', country: 'CA' },
      { keywords: ['earring'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery earrings', country: 'CA' },
      { keywords: ['pendant', 'necklace'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery pendants', country: 'CA' },
      { keywords: ['charm', 'dangle'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery charms', country: 'CA' },
      { keywords: ['stud', 'post earring'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery studs', country: 'CA' },
      { keywords: ['jewelry', 'jewellery', 'sterling', 'silver'], hsCode: '7113.11.5000', description: 'Sterling silver jewellery', country: 'CA' },
      { keywords: ['paper clip', 'paperclip', 'binder clip'], hsCode: '8305.90.3010', description: 'Office paper clips', country: 'CN' },
      { keywords: ['elastic band', 'elastic closure', 'notebook elastic', 'planner elastic'], hsCode: '6307.90.9800', description: 'Elastic for notebook', country: 'CN' },
      { keywords: ['planner charm', 'bookmark charm', 'ribbon charm'], hsCode: '7117.90.9000', description: 'Charm for notebook ribbon', country: 'CN' },
      { keywords: ['planner pocket', 'notebook pocket', 'folder insert', 'pocket insert'], hsCode: '4811.41.2100', description: 'Paper pocket for notebook', country: 'CN' },
      { keywords: ['washi', 'decorative tape', 'masking tape', 'craft tape'], hsCode: '4811.41.2100', description: 'Decorative tape for journaling', country: 'JP' }
    ];
  }

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

  buildCustomsItems(order) {
    const existing = (order.internationalOptions && order.internationalOptions.customsItems) || [];
    const bySkuExisting = new Map();
    for (const ci of existing) {
      if (ci.sku) bySkuExisting.set(ci.sku, ci);
    }

    const customsItems = [];
    for (const item of order.items) {
      const match = this.getCustomsData(item.name);
      if (match) {
        customsItems.push({
          ...(bySkuExisting.get(item.sku) && bySkuExisting.get(item.sku).customsItemId
            ? { customsItemId: bySkuExisting.get(item.sku).customsItemId }
            : {}),
          sku: item.sku || undefined,
          description: match.description,
          quantity: item.quantity || 1,
          value: Number(((item.unitPrice || 0) * (item.quantity || 1)).toFixed(2)),
          harmonizedTariffCode: match.harmonizedTariffCode,
          countryOfOrigin: match.countryOfOrigin
          // weight optional; omit unless you want to supply it
        });
      } else if (bySkuExisting.has(item.sku)) {
        // keep any existing customs line if we didn't match a rule
        customsItems.push(bySkuExisting.get(item.sku));
      }
    }
    return customsItems;
  }

  // Build the full upsert payload (no partial updates allowed).
  makeUpsertPayload(order, customsItems) {
    return {
      // Crucial: include orderKey (ShipStation’s “import key”) so we UPDATE, not CREATE.
      orderId: order.orderId,            // helps prevent duplicates on update
      orderKey: order.orderKey,          // REQUIRED by their processor when updating via createorder
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
        ? { contents: 'merchandise', customsItems }
        : order.internationalOptions
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

      const customsItems = this.buildCustomsItems(order);
      if (!customsItems.length) {
        console.log('⏭️ No customs changes to apply.');
        return;
      }

      console.log(`Applying ${customsItems.length} customs line(s)...`);
      const payload = this.makeUpsertPayload(order, customsItems);

      // Safety: ensure we didn’t change line items
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

          const customsItems = this.buildCustomsItems(order);
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
