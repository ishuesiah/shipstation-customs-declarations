'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { ShipStationAPI } = require('../shipstation-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

const { getHS, pickCustomsDescription, normHS } = require('../utils/customs-rules');
const { _norm, _scoreNameMatch, _nameVariants } = require('../utils/fuzzy-matching');
const {
  isOpen,
  isUS,
  sanitizeCustomsItems,
  ensureIntlDefaults,
  formatShipStationError,
  csvLine
} = require('../utils/shipstation-helpers');

// Client + API
const shipstation = new ShipStationAPI();

// UI
const shipstationEditorHTML = fs.readFileSync(path.join(__dirname, '../views/shipstation-editor.html'), 'utf8');
router.get('/shipstation', requireAuth, (_req, res) => res.send(shipstationEditorHTML));

/* ------------------------------- Helpers -------------------------------- */

// Map customsItems[].sku from items[].sku where possible (orderItemId/productId/name/position)
function syncCustomsSkus(order) {
  const intl = order.internationalOptions || {};
  const customs = Array.isArray(intl.customsItems) ? intl.customsItems : [];
  const items = Array.isArray(order.items) ? order.items : [];
  if (!customs.length) return { patched: order, customsSkuPlan: [] };

  const inorm = items.map((it, idx) => ({
    it,
    idx,
    sku: String(it?.sku || '').trim(),
    name: it?.name || '',
    normName: _norm(it?.name || ''),
    productId: it?.productId != null ? String(it.productId) : null,
    orderItemId:
      it?.orderItemId != null ? String(it.orderItemId) :
      it?.itemId != null ? String(it.itemId) : null
  }));

  const byProductId   = new Map(inorm.filter(x => x.productId).map(x => [x.productId, x]));
  const byOrderItemId = new Map(inorm.filter(x => x.orderItemId).map(x => [x.orderItemId, x]));
  const usedIdx = new Set();

  const plan = [];
  const patchedCustoms = customs.map((ci, cidx) => {
    const before = String(ci?.sku || '').trim();
    let after = before, chosen = null, source = before ? 'kept' : null;
    let matchedName = null, confidence = null;

    const ciOrderItemId = ci?.orderItemId != null ? String(ci.orderItemId) : null;
    const ciProductId   = ci?.productId   != null ? String(ci.productId)   : null;

    // 1) orderItemId
    if (!after && ciOrderItemId && byOrderItemId.has(ciOrderItemId)) {
      chosen = byOrderItemId.get(ciOrderItemId); source = 'orderItemId';
    }
    // 2) productId
    if (!after && !chosen && ciProductId && byProductId.has(ciProductId)) {
      chosen = byProductId.get(ciProductId); source = 'productId';
    }
    // 3) exact name
    if (!after && !chosen) {
      const qNorm = _norm(ci?.description || '');
      const exact = inorm.find(x => x.normName === qNorm && !usedIdx.has(x.idx));
      if (exact) { chosen = exact; source = 'name-exact'; }
    }
    // 4) fuzzy name
    if (!after && !chosen) {
      const q = String(ci?.description || '');
      let best = null;
      for (const cand of inorm) {
        const s = _scoreNameMatch(q, cand.name);
        if (!best || s.score > best.score) best = { cand, score: s.score };
      }
      if (best && best.cand && !usedIdx.has(best.cand.idx) && best.score >= 0.45) {
        chosen = best.cand; source = 'name-fuzzy';
        matchedName = best.cand.name || null;
        confidence = Number(best.score.toFixed(2));
      }
    }
    // 5) position fallback
    if (!after && !chosen && inorm.length === customs.length && cidx < inorm.length && !usedIdx.has(cidx)) {
      chosen = inorm[cidx]; source = 'position';
    }

    if (!after && chosen?.sku) { after = chosen.sku; matchedName = matchedName || chosen.name || null; }

    const out = { ...ci };
    if (after) out.sku = after;
    if (!out.productId && chosen?.productId) out.productId = chosen.productId;
    if (!out.orderItemId && chosen?.orderItemId) out.orderItemId = chosen.orderItemId;

    if (chosen) usedIdx.add(chosen.idx);

    plan.push({
      index: cidx,
      description: ci?.description || '',
      before,
      after,
      status: after ? (before ? (before === after ? 'kept' : 'changed') : 'filled') : 'missing',
      source: source || 'missing',
      matchedName: matchedName || undefined,
      confidence: confidence != null ? confidence : undefined,
      itemIndex: chosen?.idx
    });
    return out;
  });

  const patched = { ...order, internationalOptions: { ...intl, customsItems: patchedCustoms } };
  return { patched, customsSkuPlan: plan };
}

// Fill missing item SKUs using ShipStation products (non-fatal if not found)
async function fillMissingSkus(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const skuDiffs = [], metaByIndex = {};
  const updatedItems = await Promise.all(items.map(async (it, idx) => {
    const before = String(it.sku || '').trim();
    let resolved = before, source = null, matchedName = null, confidence = null;

    // 1) by productId
    if (!resolved && it.productId) {
      try {
        const prod = await shipstation.getProductById(it.productId);
        if (prod?.sku) { resolved = String(prod.sku); source = 'productId'; matchedName = prod.name || null; confidence = 1.0; }
      } catch {}
    }
    // 2) exact name
    if (!resolved && it.name) {
      try {
        const list = await shipstation.searchProductsByName(it.name, 200);
        if (Array.isArray(list) && list.length) {
          const exact = list.find(p => _norm(p.name) === _norm(it.name));
          if (exact?.sku) { resolved = String(exact.sku); source = 'name-exact'; matchedName = exact.name || null; confidence = 1.0; }
        }
      } catch {}
    }
    // 3) fuzzy name
    if (!resolved && it.name) {
      try {
        let best = null;
        for (const q of _nameVariants(it.name)) {
          const list = await shipstation.searchProductsByName(q, 200);
          if (!Array.isArray(list) || !list.length) continue;
          for (const p of list) {
            const s = _scoreNameMatch(it.name, p.name || '');
            const cand = { product: p, score: s.score };
            if (!best || cand.score > best.score) best = cand;
          }
          if (best && best.score >= 0.8) break;
        }
        if (best?.product?.sku && best.score >= 0.55) {
          resolved = String(best.product.sku); source = 'name-fuzzy'; matchedName = best.product.name || null; confidence = Number(best.score.toFixed(2));
        }
      } catch {}
    }

    if (source || !resolved) {
      metaByIndex[idx] = { source: source || (resolved ? 'kept' : 'missing'), matchedName, confidence };
    }
    if (resolved && resolved !== before) {
      skuDiffs.push({ index: idx, itemName: it.name || '', from: before || '', to: resolved, source, confidence, matchedName });
      return { ...it, sku: resolved };
    }
    return it;
  }));
  return { patched: { ...order, items: updatedItems }, skuDiffs, resolutions: metaByIndex };
}

// Compute customs description + HS patch plan
function buildCustomsPatch(order) {
  if (!isUS(order)) return { canUpdate: false, reason: 'Order is not shipping to US.' };

  const intl = order.internationalOptions || {};
  const existing =
    Array.isArray(intl.customsItems) ? intl.customsItems :
    Array.isArray(order.customsItems) ? order.customsItems : [];

  if (!existing.length) return { canUpdate: false, reason: 'No customsItems on this order to edit.' };

  const itemTitles = (order.items || []).map(i => String(i.name || ''));
  const analysis = [];

  const updated = existing.map((ci, idx) => {
    const hsRaw  = getHS(ci);
    const hsNorm = normHS(hsRaw);
    const cur    = String(ci.description || '');
    const bestT  = cur || itemTitles.find(t => t) || '';

    const pick = pickCustomsDescription(hsRaw, bestT);
    const newDesc = pick.desc;
    const descChanged = cur.trim() !== String(newDesc).trim();

    const newHS = pick.overrideHS ? String(pick.overrideHS) : hsRaw;
    const hsChanged = pick.overrideHS ? (normHS(hsRaw) !== normHS(pick.overrideHS)) : false;

    analysis.push({
      index: idx, hs: hsRaw, hsNormalized: hsNorm, hsNew: hsChanged ? newHS : hsRaw,
      from: cur, mapped: newDesc, rule: pick.rule, willChange: descChanged || hsChanged
    });

    const out = { ...ci };
    if (descChanged) out.description = newDesc;
    if (hsChanged)   out.harmonizedTariffCode = newHS;
    return out;
  });

  const diff = analysis.filter(a => a.willChange).map(a => ({
    index: a.index, harmonizedCode: a.hs, harmonizedCodeNew: a.hsNew, from: a.from, to: a.mapped
  }));

  const anyCustomsChange = diff.length > 0;
  const patchedOrder = anyCustomsChange
    ? { ...order, internationalOptions: { ...(order.internationalOptions || {}), customsItems: updated } }
    : { ...order };

  return { canUpdate: true, diff, patchedOrder, analysis, anyCustomsChange };
}

// Lookup order by id → number → key
async function loadOrderByAnyRef(ref) {
  try { const o = await shipstation.getOrder(ref); if (o && o.orderId) return o; }
  catch (e) { if (e?.response?.status !== 404) throw e; }
  const byNum = await shipstation.getOrderByNumber(ref); if (byNum) return byNum;
  const byKey = await shipstation.getOrderByKey(ref);   if (byKey) return byKey;
  return null;
}

// Wrapper for ShipStation update
async function tryCreateOrUpdate(body, tag) {
  console.log(`\n[ShipStation try ${tag}] keys: ${Object.keys(body).sort().join(', ')}`);
  try {
    const updated = await shipstation.createOrUpdateOrder(body);
    console.log(`[ShipStation ${tag}] OK -> orderId=${updated?.orderId}`);
    return { ok: true, data: updated };
  } catch (e) {
    const { status, message } = formatShipStationError(e);
    console.log(`[ShipStation ${tag}] ERROR ${status || ''}: ${message}`);
    return { ok: false, status, message };
  }
}

/* --------------------------------- API ---------------------------------- */

// Scan open US orders for description/HS mismatches
router.get('/api/shipstation/orders/scan', requireAuthApi, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, Number(req.query.days || 30)));
    const pageSize = Math.max(25, Math.min(200, Number(req.query.pageSize || 100)));
    const maxPages = Math.max(1, Math.min(50, Number(req.query.maxPages || 5)));
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const statuses = ['awaiting_shipment','awaiting_payment','on_hold'];
    const seen = new Set(), candidates = [];

    for (const status of statuses) {
      let page = 1;
      while (page <= maxPages) {
        const list = await shipstation.searchOrders({
          modifyDateStart: since,
          orderStatus: status,
          sortBy: 'ModifyDate',
          sortDir: 'DESC',
          page,
          pageSize
        });
        if (!list.length) break;

        for (const o of list) {
          if (seen.has(o.orderId)) continue;
          seen.add(o.orderId);
          if (!isUS(o)) continue;

          const full = await shipstation.getOrder(o.orderId);
          if (!isOpen(full)) continue;

          const { canUpdate, diff, analysis } = buildCustomsPatch(full);
          if (canUpdate && diff.length > 0) {
            candidates.push({
              orderId: full.orderId,
              orderNumber: full.orderNumber,
              orderDate: full.orderDate,
              shipTo: full.shipTo,
              changes: diff.length,
              diff,
              analysis
            });
          }
        }
        if (list.length < pageSize) break;
        page++;
      }
    }
    res.json({ scannedDays: days, totalCandidates: candidates.length, candidates });
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

// CSV export for audit/debug
router.get('/api/shipstation/orders/export.csv', requireAuthApi, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const pageSize = Math.max(25, Math.min(200, Number(req.query.pageSize || 100)));
    const maxPages = Math.max(1, Math.min(50, Number(req.query.maxPages || 5)));
    const scope = String(req.query.scope || 'mismatched').toLowerCase();
    const mode  = String(req.query.mode || 'item').toLowerCase();

    const statuses = (req.query.statuses
      ? String(req.query.statuses).split(',').map(s => s.trim()).filter(Boolean)
      : (scope === 'all'
          ? ['awaiting_payment','awaiting_shipment','on_hold','shipped','delivered']
          : ['awaiting_payment','awaiting_shipment','on_hold']
        )
    );

    const since = new Date(Date.now() - days * 864e5).toISOString();
    const seen = new Set(), orders = [];

    for (const status of statuses) {
      let page = 1;
      while (page <= maxPages) {
        const list = await shipstation.searchOrders({
          modifyDateStart: since,
          orderStatus: status,
          sortBy: 'ModifyDate',
          sortDir: 'DESC',
          page,
          pageSize
        });
        if (!list.length) break;
        for (const o of list) {
          if (seen.has(o.orderId)) continue;
          seen.add(o.orderId);
          if (!isUS(o)) continue;
          const full = await shipstation.getOrder(o.orderId);
          orders.push(full);
        }
        if (list.length < pageSize) break;
        page++;
      }
    }

    const rows = [];
    for (const order of orders) {
      const { canUpdate, analysis, anyCustomsChange } = buildCustomsPatch(order);
      if (!canUpdate) continue;
      if (scope === 'mismatched' && !anyCustomsChange) continue;

      const { patched: withSkus } = await fillMissingSkus(order);
      const { customsSkuPlan, patched: mappedOrder } = syncCustomsSkus(withSkus);

      const intl = mappedOrder.internationalOptions || {};
      const customs = Array.isArray(intl.customsItems) ? intl.customsItems : [];
      const items   = Array.isArray(mappedOrder.items) ? mappedOrder.items : [];
      const analysisByIndex = new Map((analysis || []).map(a => [a.index, a]));

      if (mode === 'item') {
        items.forEach((it, idx) => {
          const link = customsSkuPlan.find(c => c.itemIndex === idx) || null;
          const a = link ? analysisByIndex.get(link.index) : null;
          rows.push({
            orderId: order.orderId, orderNumber: order.orderNumber, orderDate: order.orderDate, orderStatus: order.orderStatus,
            shipToCity: order?.shipTo?.city || '', shipToState: order?.shipTo?.state || '', shipToCountry: order?.shipTo?.country || '',
            itemIndex: idx, itemName: it?.name || '', itemSku: (it?.sku || '').trim(), itemQty: it?.quantity ?? '',
            itemProductId: it?.productId ?? '', itemOrderItemId: it?.orderItemId ?? it?.itemId ?? '',
            customsIndex: link?.index ?? '', customsDesc: link ? (customs[link.index]?.description ?? '') : '', customsHS: link ? (getHS(customs[link.index]) || '') : '',
            customsQty: link ? (customs[link.index]?.quantity ?? '') : '', customsValue: link ? (customs[link.index]?.value ?? '') : '',
            mappingSource: link?.source || '', mappingConfidence: typeof link?.confidence === 'number' ? link.confidence : '',
            rule: a?.rule || '', recommendedDesc: a?.mapped ?? '', recommendedHS: a && a.hsNew !== a.hs ? a.hsNew : '', willChange: a ? (a.willChange ? 'YES' : 'NO') : ''
          });
        });
      } else {
        customs.forEach((ci, cidx) => {
          const link = customsSkuPlan.find(c => c.index === cidx) || null;
          const item = link && typeof link.itemIndex === 'number' ? items[link.itemIndex] : null;
          const a = analysisByIndex.get(cidx);
          rows.push({
            orderId: order.orderId, orderNumber: order.orderNumber, orderDate: order.orderDate, orderStatus: order.orderStatus,
            shipToCity: order?.shipTo?.city || '', shipToState: order?.shipTo?.state || '', shipToCountry: order?.shipTo?.country || '',
            customsIndex: cidx, customsDesc: ci?.description || '', customsHS: getHS(ci) || '', customsQty: ci?.quantity ?? '', customsValue: ci?.value ?? '',
            itemIndex: link?.itemIndex ?? '', itemName: item?.name || '', itemSku: (item?.sku || '').trim(), itemQty: item?.quantity ?? '',
            itemProductId: item?.productId ?? '', itemOrderItemId: item?.orderItemId ?? item?.itemId ?? '',
            mappingSource: link?.source || '', mappingConfidence: typeof link?.confidence === 'number' ? link.confidence : '',
            rule: a?.rule || '', recommendedDesc: a?.mapped ?? '', recommendedHS: a && a.hsNew !== a.hs ? a.hsNew : '', willChange: a ? (a.willChange ? 'YES' : 'NO') : ''
          });
        });
      }
    }

    const headers = (mode === 'item')
      ? ['orderId','orderNumber','orderDate','orderStatus','shipToCity','shipToState','shipToCountry','itemIndex','itemName','itemSku','itemQty','itemProductId','itemOrderItemId','customsIndex','customsDesc','customsHS','customsQty','customsValue','mappingSource','mappingConfidence','rule','recommendedDesc','recommendedHS','willChange']
      : ['orderId','orderNumber','orderDate','orderStatus','shipToCity','shipToState','shipToCountry','customsIndex','customsDesc','customsHS','customsQty','customsValue','itemIndex','itemName','itemSku','itemQty','itemProductId','itemOrderItemId','mappingSource','mappingConfidence','rule','recommendedDesc','recommendedHS','willChange'];

    const out = [csvLine(headers)];
    rows.forEach(r => out.push(csvLine(headers.map(h => r[h]))));

    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipstation_usa_${scope}_${mode}_${stamp}.csv"`);
    res.send(out.join('\n'));
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

// Also fix the bulk-update route - find this section and replace the payload:
router.post('/api/shipstation/orders/bulk-update', requireAuthApi, async (req, res) => {
  try {
    const { orderIds } = req.body || {};
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return res.status(400).json({ error: 'Provide orderIds: string[]' });
    }

    const results = [];
    for (const raw of orderIds) {
      const ref = String(raw);
      try {
        const order = await loadOrderByAnyRef(ref);
        if (!order)         { results.push({ ref, ok:false, error:'Not found' }); continue; }
        if (!isOpen(order)) { results.push({ ref, ok:false, error:`Status ${order.orderStatus}` }); continue; }
        if (!isUS(order))   { results.push({ ref, ok:false, error:'Not US' }); continue; }

        const { canUpdate, diff, patchedOrder, anyCustomsChange } = buildCustomsPatch(order);
        if (!canUpdate || !anyCustomsChange) { results.push({ ref, ok:false, error:'No customs changes' }); continue; }

        const { patched: withSkus } = await fillMissingSkus(patchedOrder);
        const { patched: withCustomsSkus } = syncCustomsSkus(withSkus);

        const intlBase = ensureIntlDefaults(order.internationalOptions || {});
        const sanitized = sanitizeCustomsItems(
          withCustomsSkus.internationalOptions?.customsItems || [],
          getHS
        );

        // USE THE SAME COMPLETE PAYLOAD AS SINGLE UPDATE
        const payload = {
          // Primary identifiers
          orderId: order.orderId,
          orderKey: order.orderKey,
          orderNumber: order.orderNumber,
          
          // All dates
          orderDate: order.orderDate,
          paymentDate: order.paymentDate || order.orderDate,
          shipByDate: order.shipByDate,
          
          // Status
          orderStatus: order.orderStatus,
          
          // Customer
          customerUsername: order.customerUsername || '',
          customerEmail: order.customerEmail || '',
          customerId: order.customerId,
          
          // Addresses
          billTo: order.billTo,
          shipTo: order.shipTo,
          
          // Financial
          amountPaid: order.amountPaid || 0,
          taxAmount: order.taxAmount || 0,
          shippingAmount: order.shippingAmount || 0,
          customerNotes: order.customerNotes || '',
          internalNotes: order.internalNotes || '',
          
          // Gift
          gift: order.gift || false,
          giftMessage: order.giftMessage || '',
          
          // Shipping
          requestedShippingService: order.requestedShippingService,
          carrierCode: order.carrierCode,
          serviceCode: order.serviceCode,
          packageCode: order.packageCode,
          confirmation: order.confirmation,
          shipDate: order.shipDate,
          
          // Physical
          weight: order.weight || {},
          dimensions: order.dimensions || {},
          
          // Options
          insuranceOptions: order.insuranceOptions || {},
          advancedOptions: order.advancedOptions || {},
          tagIds: order.tagIds || [],
          
          // Items
          items: withCustomsSkus.items.map(item => ({
            orderItemId: item.orderItemId,
            lineItemKey: item.lineItemKey || '',
            sku: item.sku || '',
            name: item.name || '',
            imageUrl: item.imageUrl || '',
            weight: item.weight || {},
            quantity: item.quantity || 1,
            unitPrice: item.unitPrice || 0,
            taxAmount: item.taxAmount || 0,
            shippingAmount: item.shippingAmount || 0,
            warehouseLocation: item.warehouseLocation || '',
            options: item.options || [],
            productId: item.productId,
            fulfillmentSku: item.fulfillmentSku || '',
            adjustment: item.adjustment || false,
            upc: item.upc || ''
          })),
          
          // International with updated customs
          internationalOptions: {
            ...intlBase,
            customsItems: sanitized
          }
        };

        const final = await tryCreateOrUpdate(payload, `bulk:${ref}`);
        if (!final.ok) { results.push({ ref, ok:false, status: final.status, error: final.message }); continue; }

        results.push({ ref, ok:true, updatedOrderId: final.data.orderId, changedDescriptions: diff.length });
      } catch (e) {
        const { status, message } = formatShipStationError(e);
        results.push({ ref, ok:false, status, error: message });
      }
    }

    res.json({ updated: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});


// Preview one order
router.get('/api/shipstation/orders/:orderId/preview', requireAuthApi, async (req, res) => {
  try {
    const ref = req.params.orderId;
    const order = await loadOrderByAnyRef(ref);
    if (!order) return res.status(404).json({ error: `Order not found for id/number/key "${ref}"` });

    const open = ['awaiting_payment','awaiting_shipment','on_hold']
      .includes(String(order.orderStatus || '').toLowerCase());
    if (!open) return res.status(400).json({ error: `Order status is ${order.orderStatus}. Only open orders can be updated.` });

    const result = buildCustomsPatch(order);
    if (!result.canUpdate) return res.status(400).json({ error: result.reason, order });

    const { patched: withSkus, skuDiffs, resolutions } = await fillMissingSkus(result.patchedOrder);
    const { patched: withCustomsSkus, customsSkuPlan } = syncCustomsSkus(withSkus);

    const origItems = Array.isArray(order.items) ? order.items : [];
    const withItems = Array.isArray(withCustomsSkus.items) ? withCustomsSkus.items : [];
    const keyOf = (it, idx) => String(it?.orderItemId ?? it?.itemId ?? it?.productId ?? `idx:${idx}`);
    const origByKey = new Map(origItems.map((it, i) => [keyOf(it, i), { it, i }]));
    const skuPlan = withItems.map((it, i) => {
      const key = keyOf(it, i);
      const orig = (origByKey.get(key)?.it) || origItems[i] || {};
      const before = String(orig.sku || '').trim();
      const after  = String(it.sku || '').trim();
      let status = 'kept';
      if (!before && after) status = 'filled';
      else if (!after) status = 'missing';
      else if (before && after && before !== after) status = 'changed';
      const meta = resolutions[i] || {};
      return {
        index: i, itemName: it.name || orig.name || '', before, after, status,
        source: meta.source || (status === 'kept' ? 'kept' : undefined),
        matchedName: meta.matchedName || undefined,
        confidence: typeof meta.confidence === 'number' ? meta.confidence : undefined
      };
    });

    res.json({
      orderId: order.orderId,
      shipTo: order.shipTo,
      diff: result.diff,
      analysis: result.analysis,
      skuDiffs,
      skuPlan,
      customsSkuPlan,
      patchedOrder: withCustomsSkus
    });
  } catch (err) {
    const { status, message } = formatShipStationError(err);
    res.status(status || 500).json({ error: message });
  }
});

// Replace the handleOrderUpdate function in routes/shipstation.js
async function handleOrderUpdate(req, res) {
  console.log(`\n=== ROUTE HIT: ${req.method} ${req.originalUrl} ===`);
  try {
    const ref = req.params.orderId;
    const order = await loadOrderByAnyRef(ref);
    if (!order) return res.status(404).json({ error: `Order not found for id/number/key "${ref}"` });
    if (!isOpen(order)) return res.status(400).json({ error: `Order status is ${order.orderStatus}. Only open orders can be updated.` });

    const { canUpdate, diff, patchedOrder, anyCustomsChange } = buildCustomsPatch(order);
    if (!canUpdate) return res.status(400).json({ error: 'Cannot update this order.' });
    if (!anyCustomsChange) return res.json({ ok: true, updatedOrderId: order.orderId, changedDescriptions: 0, diff: [] });

    const { patched: withSkus } = await fillMissingSkus(patchedOrder);
    const { patched: withCustomsSkus } = syncCustomsSkus(withSkus);

    const intlBase = ensureIntlDefaults(order.internationalOptions || {});
    const sanitized = sanitizeCustomsItems(
      withCustomsSkus.internationalOptions?.customsItems || [],
      getHS
    );

    // COMPLETE PAYLOAD - ALL FIELDS NEEDED TO PREVENT DUPLICATE ORDERS
    const payload = {
      // Primary identifiers
      orderId: order.orderId,
      orderKey: order.orderKey,
      orderNumber: order.orderNumber,
      
      // All dates
      orderDate: order.orderDate,
      paymentDate: order.paymentDate || order.orderDate,
      shipByDate: order.shipByDate,
      
      // Status
      orderStatus: order.orderStatus,
      
      // Customer
      customerUsername: order.customerUsername || '',
      customerEmail: order.customerEmail || '',
      customerId: order.customerId,
      
      // Addresses
      billTo: order.billTo,
      shipTo: order.shipTo,
      
      // Financial
      amountPaid: order.amountPaid || 0,
      taxAmount: order.taxAmount || 0,
      shippingAmount: order.shippingAmount || 0,
      customerNotes: order.customerNotes || '',
      internalNotes: order.internalNotes || '',
      
      // Gift
      gift: order.gift || false,
      giftMessage: order.giftMessage || '',
      
      // Shipping
      requestedShippingService: order.requestedShippingService,
      carrierCode: order.carrierCode,
      serviceCode: order.serviceCode,
      packageCode: order.packageCode,
      confirmation: order.confirmation,
      shipDate: order.shipDate,
      
      // Physical
      weight: order.weight || {},
      dimensions: order.dimensions || {},
      
      // Options
      insuranceOptions: order.insuranceOptions || {},
      advancedOptions: order.advancedOptions || {},
      tagIds: order.tagIds || [],
      
      // Items - complete structure
      items: withCustomsSkus.items.map(item => ({
        orderItemId: item.orderItemId,
        lineItemKey: item.lineItemKey || '',
        sku: item.sku || '',
        name: item.name || '',
        imageUrl: item.imageUrl || '',
        weight: item.weight || {},
        quantity: item.quantity || 1,
        unitPrice: item.unitPrice || 0,
        taxAmount: item.taxAmount || 0,
        shippingAmount: item.shippingAmount || 0,
        warehouseLocation: item.warehouseLocation || '',
        options: item.options || [],
        productId: item.productId,
        fulfillmentSku: item.fulfillmentSku || '',
        adjustment: item.adjustment || false,
        upc: item.upc || ''
      })),
      
      // International with updated customs
      internationalOptions: {
        ...intlBase,
        customsItems: sanitized
      }
    };

    const result = await tryCreateOrUpdate(payload, 'single');
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.message || 'Update failed' });
    }

    return res.json({ ok: true, updatedOrderId: result.data.orderId, changedDescriptions: diff.length, diff });
  } catch (err) {
    const { status, message } = formatShipStationError(err);
    return res.status(status || 400).json({ error: message });
  }
}

router.post('/api/shipstation/orders/:orderId/update', requireAuthApi, handleOrderUpdate);
router.get('/api/shipstation/orders/:orderId/update', requireAuthApi, handleOrderUpdate);

module.exports = router;
