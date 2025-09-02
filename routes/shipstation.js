'use strict';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;  // Use fs.promises for async operations
const fsSync = require('fs');       // Keep sync version for readFileSync
const path = require('path');

const { ShipStationAPI } = require('../shipstation-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

const { 
  getHS, 
  pickCustomsDescription, 
  normHS,
  identifyProductFromTitle,
  getCorrectHSAndDescription 
} = require('../utils/customs-rules');
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

// UI - use sync version for initial HTML load
const shipstationEditorHTML = fsSync.readFileSync(path.join(__dirname, '../views/shipstation-editor.html'), 'utf8');
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

// SCAN ROUTE 
router.get('/api/shipstation/orders/scan', requireAuthApi, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const pageSize = Math.max(25, Math.min(200, Number(req.query.pageSize || 200)));
    const maxPages = Math.max(1, Math.min(50, Number(req.query.maxPages || 10)));
    
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const statuses = ['awaiting_shipment','awaiting_payment','on_hold'];
    const seen = new Set(), candidates = [];
    const allUsOrders = []; // Track ALL US orders checked
    
    let totalScanned = 0;
    let usOrders = 0;
    let nonUsOrders = 0;
    const scanLog = [];
    
    console.log(`Starting scan for ${days} days of orders...`);
    scanLog.push(`Starting scan for ${days} days (since ${since.split('T')[0]})`);

    for (const status of statuses) {
      let page = 1;
      while (page <= maxPages) {
        console.log(`Scanning ${status} - page ${page}...`);
        scanLog.push(`Fetching ${status} orders - page ${page}...`);
        
        await delay(1500);
        
        const list = await shipstation.searchOrders({
          createDateStart: since,
          orderStatus: status,
          sortBy: 'OrderDate',
          sortDir: 'DESC',
          page,
          pageSize
        });
        
        console.log(`Got ${list.length} orders from page ${page}`);
        if (!list.length) break;
        scanLog.push(`Found ${list.length} ${status} orders on page ${page}`);
        totalScanned += list.length;

        for (const o of list) {
          if (seen.has(o.orderId)) continue;
          seen.add(o.orderId);
          
          if (!isUS(o)) {
            nonUsOrders++;
            continue;
          }
          
          usOrders++;
          
          await delay(100);
          
          const full = await shipstation.getOrder(o.orderId);
          
          // Track ALL US orders with their items
          allUsOrders.push({
            orderId: full.orderId,
            orderNumber: full.orderNumber,
            orderDate: full.orderDate,
            shipTo: full.shipTo,
            status: full.orderStatus,
            items: (full.items || []).map(i => ({
              name: i.name,
              sku: i.sku,
              quantity: i.quantity
            }))
          });
          
          if (!isOpen(full)) continue;
          
          const { canUpdate, diff, analysis } = buildCustomsPatch(full);
          if (canUpdate && diff.length > 0) {
            // Include item details with the candidates
            candidates.push({
              orderId: full.orderId,
              orderNumber: full.orderNumber,
              orderDate: full.orderDate,
              shipTo: full.shipTo,
              changes: diff.length,
              diff,
              analysis,
              items: (full.items || []).map(i => ({
                name: i.name,
                sku: i.sku,
                quantity: i.quantity
              }))
            });
            scanLog.push(`✓ Order #${full.orderNumber} needs ${diff.length} fixes`);
          }
        }
        
        if (list.length < pageSize) break;
        page++;
      }
    }
    
    scanLog.push(`Scan complete: ${totalScanned} total, ${usOrders} US, ${nonUsOrders} non-US, ${candidates.length} need fixes`);
    console.log(`Scan complete. Scanned ${totalScanned} orders, found ${candidates.length} needing updates.`);
    
    res.json({ 
      scannedDays: days, 
      totalScanned, 
      usOrders,
      nonUsOrders,
      totalCandidates: candidates.length, 
      candidates,
      allUsOrders,  // Now includes all US orders checked
      scanLog 
    });
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    
    if (status === 429) {
      console.log('Rate limit hit - consider increasing delays');
    }
    
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

    const statuses = ['awaiting_payment','awaiting_shipment','on_hold'];
    if (scope === 'all') {
      statuses.push('shipped', 'delivered');
    }

    const since = new Date(Date.now() - days * 864e5).toISOString();
    const seen = new Set(), orders = [];

    // Fetch orders
    for (const status of statuses) {
      let page = 1;
      while (page <= maxPages) {
        await delay(1500); // Rate limit protection
        
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
          
          await delay(100); // Small delay between individual order fetches
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
      
      // For mismatched scope, skip orders with no changes needed
      if (scope === 'mismatched' && !anyCustomsChange) continue;
      
      const items = Array.isArray(order.items) ? order.items : [];
      const customs = Array.isArray(order.internationalOptions?.customsItems) ? order.internationalOptions.customsItems : [];
      
      // Create ONE row per item in the order
      items.forEach((item, itemIdx) => {
        // Find best matching customs entry for this specific item
        let bestCustomsMatch = null;
        let bestAnalysis = null;
        let matchMethod = 'NONE';
        
        // Try exact SKU match first
        if (item.sku) {
          const customsIdx = customs.findIndex(c => 
            String(c.sku || '').trim().toUpperCase() === String(item.sku).trim().toUpperCase()
          );
          if (customsIdx >= 0) {
            bestCustomsMatch = customs[customsIdx];
            bestAnalysis = analysis?.[customsIdx];
            matchMethod = 'SKU';
          }
        }
        
        // Try name matching if no SKU match
        if (!bestCustomsMatch && item.name) {
          // Look for best name match
          let bestScore = 0;
          let bestIdx = -1;
          
          customs.forEach((c, idx) => {
            const itemName = String(item.name || '').toLowerCase();
            const customsDesc = String(c.description || '').toLowerCase();
            
            // Calculate similarity score
            let score = 0;
            if (itemName === customsDesc) score = 1.0;
            else if (itemName.includes(customsDesc) || customsDesc.includes(itemName)) score = 0.8;
            else {
              // Check for common words
              const itemWords = itemName.split(/\s+/);
              const customsWords = customsDesc.split(/\s+/);
              const commonWords = itemWords.filter(w => customsWords.includes(w)).length;
              score = commonWords / Math.max(itemWords.length, customsWords.length);
            }
            
            if (score > bestScore) {
              bestScore = score;
              bestIdx = idx;
            }
          });
          
          if (bestIdx >= 0 && bestScore > 0.3) {
            bestCustomsMatch = customs[bestIdx];
            bestAnalysis = analysis?.[bestIdx];
            matchMethod = `NAME_${Math.round(bestScore * 100)}%`;
          }
        }
        
        // Determine what the product type likely is from the name
        const productType = identifyProductFromTitle(item.name);
        const suggestedHS = productType ? getCorrectHSAndDescription(productType)?.hs : '';
        const suggestedDesc = productType ? getCorrectHSAndDescription(productType)?.desc : '';
        
        rows.push({
          // Order info
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          orderDate: order.orderDate,
          orderStatus: order.orderStatus,
          shipToCity: order?.shipTo?.city || '',
          shipToState: order?.shipTo?.state || '',
          shipToCountry: order?.shipTo?.country || '',
          
          // Actual item from order
          itemName: item?.name || '',
          itemSku: String(item?.sku || '').trim(),
          itemQty: item?.quantity || 1,
          itemUnitPrice: item?.unitPrice || '',
          itemProductId: item?.productId || '',
          
          // Current customs match (if any)
          currentCustomsDesc: bestCustomsMatch?.description || 'NOT MATCHED',
          currentCustomsHS: bestCustomsMatch ? getHS(bestCustomsMatch) : '',
          currentCustomsValue: bestCustomsMatch?.value || '',
          
          // Suggested based on product name
          suggestedDesc: suggestedDesc || bestAnalysis?.mapped || '',
          suggestedHS: suggestedHS || bestAnalysis?.hsNew || '',
          
          // Match quality
          matchMethod: matchMethod,
          needsUpdate: bestAnalysis?.willChange ? 'YES' : 'NO'
        });
      });
    }

    const headers = [
      'orderId', 'orderNumber', 'orderDate', 'orderStatus',
      'shipToCity', 'shipToState', 'shipToCountry',
      'itemName', 'itemSku', 'itemQty', 'itemUnitPrice', 'itemProductId',
      'currentCustomsDesc', 'currentCustomsHS', 'currentCustomsValue',
      'suggestedDesc', 'suggestedHS',
      'matchMethod', 'needsUpdate'
    ];

    const out = [csvLine(headers)];
    rows.forEach(r => out.push(csvLine(headers.map(h => r[h]))));
    
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const csv = out.join('\n');
    
    // Save backup copy locally
    try {
      const exportsDir = path.join(__dirname, '../exports');
      await fs.mkdir(exportsDir, { recursive: true });
      const filename = `shipstation_usa_${scope}_products_${stamp}.csv`;
      const filepath = path.join(exportsDir, filename);
      await fs.writeFile(filepath, csv);
      console.log(`✅ CSV saved locally: ${filepath}`);
    } catch (saveErr) {
      console.error('Failed to save backup:', saveErr);
    }
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipstation_usa_${scope}_products_${stamp}.csv"`);
    res.send(csv);
    
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

// Bulk update route
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

// Handle order update
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

// Single order export route
router.get('/api/shipstation/orders/export-single.csv', requireAuthApi, async (req, res) => {
  try {
    const orderId = req.query.orderId;
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID required' });
    }
    
    const order = await loadOrderByAnyRef(orderId);
    if (!order) {
      return res.status(404).json({ error: `Order not found: ${orderId}` });
    }
    
    if (!isUS(order)) {
      return res.status(400).json({ error: 'Order is not shipping to US' });
    }
    
    const { canUpdate, analysis } = buildCustomsPatch(order);
    const items = Array.isArray(order.items) ? order.items : [];
    const customs = Array.isArray(order.internationalOptions?.customsItems) ? order.internationalOptions.customsItems : [];
    
    console.log(`\nOrder ${order.orderNumber}: ${items.length} items, ${customs.length} customs entries`);
    
    const rows = [];
    const availableCustomsIndices = new Set();
    customs.forEach((_, idx) => availableCustomsIndices.add(idx));
    
    // Track if this is the first row for the order
    let isFirstRow = true;
    
    // Match each item to an appropriate customs declaration
    items.forEach((item, itemIdx) => {
      console.log(`\nMatching item: "${item.name}"`);
      
      const itemType = identifyProductFromTitle(item.name);
      console.log(`  Detected type: ${itemType || 'unknown'}`);
      
      let bestMatch = null;
      let bestIdx = -1;
      let matchMethod = 'NONE';
      
      for (const cidx of availableCustomsIndices) {
        const c = customs[cidx];
        const customsDesc = String(c.description || '').toLowerCase();
        const customsHS = getHS(c);
        
        let isMatch = false;
        let matchReason = '';
        
        if (itemType) {
          const correctForType = getCorrectHSAndDescription(itemType);
          
          if (correctForType && customsHS && normHS(customsHS) === normHS(correctForType.hs)) {
            isMatch = true;
            matchReason = `HS_MATCH_${itemType}`;
          }
          else if (itemType === 'notebook' && customsDesc.includes('notebook')) {
            isMatch = true;
            matchReason = 'DESC_NOTEBOOK';
          }
          else if (itemType === 'planner' && customsDesc.includes('planner')) {
            isMatch = true;
            matchReason = 'DESC_PLANNER';
          }
          else if (itemType === 'sticker' && customsDesc.includes('sticker')) {
            isMatch = true;
            matchReason = 'DESC_STICKER';
          }
          else if (itemType === 'sticky' && customsDesc.includes('sticky')) {
            isMatch = true;
            matchReason = 'DESC_STICKY';
          }
          else if (itemType === 'insert' && (customsDesc.includes('insert') || customsDesc.includes('refill'))) {
            isMatch = true;
            matchReason = 'DESC_INSERT';
          }
        }
        
        if (!isMatch) {
          const itemLower = String(item.name || '').toLowerCase();
          
          const categories = [
            { keywords: ['notebook', 'journal'], customsTerms: ['notebook', 'journal'] },
            { keywords: ['planner', 'agenda'], customsTerms: ['planner', 'agenda', 'diary'] },
            { keywords: ['sticky', 'post-it'], customsTerms: ['sticky', 'notepad'] },
            { keywords: ['sticker'], customsTerms: ['sticker'] },
            { keywords: ['insert', 'refill'], customsTerms: ['insert', 'refill', 'loose'] },
            { keywords: ['tab', 'tabs'], customsTerms: ['sticker', 'paper'] },
            { keywords: ['pen'], customsTerms: ['pen'] },
            { keywords: ['tape', 'washi'], customsTerms: ['tape'] },
            { keywords: ['clip'], customsTerms: ['clip'] },
            { keywords: ['charm'], customsTerms: ['charm'] },
            { keywords: ['elastic'], customsTerms: ['elastic'] }
          ];
          
          for (const cat of categories) {
            const hasItemKeyword = cat.keywords.some(k => itemLower.includes(k));
            const hasCustomsKeyword = cat.customsTerms.some(t => customsDesc.includes(t));
            
            if (hasItemKeyword && hasCustomsKeyword) {
              isMatch = true;
              matchReason = `CATEGORY_${cat.keywords[0].toUpperCase()}`;
              break;
            }
          }
        }
        
        if (isMatch && item.quantity === c.quantity) {
          matchReason += '_QTY';
        }
        
        if (isMatch) {
          bestMatch = c;
          bestIdx = cidx;
          matchMethod = matchReason;
          console.log(`  ✓ Matched to customs[${cidx}]: "${c.description}" via ${matchReason}`);
          break;
        }
      }
      
      if (!bestMatch && availableCustomsIndices.size > 0) {
        const firstAvailable = Array.from(availableCustomsIndices)[0];
        bestMatch = customs[firstAvailable];
        bestIdx = firstAvailable;
        matchMethod = 'FALLBACK';
        console.log(`  → Fallback to customs[${firstAvailable}]: "${bestMatch.description}"`);
      }
      
      if (bestIdx >= 0) {
        availableCustomsIndices.delete(bestIdx);
      }
      
      const bestAnalysis = bestIdx >= 0 ? analysis?.[bestIdx] : null;
      const productType = itemType || identifyProductFromTitle(item.name);
      const correct = productType ? getCorrectHSAndDescription(productType) : null;
      
      rows.push({
        // Order info - only show on first row
        orderId: isFirstRow ? order.orderId : '',
        orderNumber: isFirstRow ? order.orderNumber : '',
        orderDate: isFirstRow ? order.orderDate : '',
        orderStatus: isFirstRow ? order.orderStatus : '',
        shipToCity: isFirstRow ? (order?.shipTo?.city || '') : '',
        shipToState: isFirstRow ? (order?.shipTo?.state || '') : '',
        
        // Item details - always show
        itemIndex: itemIdx,
        itemName: item?.name || '',
        itemSku: String(item?.sku || '').trim(),
        itemQty: item?.quantity || 1,
        itemUnitPrice: item?.unitPrice || '',
        
        // Matched customs - always show
        currentCustomsDesc: bestMatch?.description || '',
        currentCustomsHS: bestMatch ? getHS(bestMatch) : '',
        currentCustomsQty: bestMatch?.quantity || '',
        currentCustomsValue: bestMatch?.value || '',
        
        // Suggestions - always show
        suggestedDesc: correct?.desc || bestAnalysis?.mapped || '',
        suggestedHS: correct?.hs || bestAnalysis?.hsNew || '',
        
        // Metadata - always show
        matchMethod: matchMethod,
        productTypeDetected: productType || ''
      });
      
      // After first row, set flag to false
      isFirstRow = false;
    });
    
    // Add any remaining unmatched customs entries
    availableCustomsIndices.forEach(cidx => {
      const c = customs[cidx];
      console.log(`\nUnmatched customs[${cidx}]: "${c.description}"`);
      
      rows.push({
        // No order info for orphaned customs rows
        orderId: '',
        orderNumber: '',
        orderDate: '',
        orderStatus: '',
        shipToCity: '',
        shipToState: '',
        
        itemIndex: '',
        itemName: '>>> UNMATCHED CUSTOMS <<<',
        itemSku: c.sku || '',
        itemQty: '',
        itemUnitPrice: '',
        
        currentCustomsDesc: c.description || '',
        currentCustomsHS: getHS(c) || '',
        currentCustomsQty: c.quantity || '',
        currentCustomsValue: c.value || '',
        
        suggestedDesc: '',
        suggestedHS: '',
        
        matchMethod: 'ORPHANED',
        productTypeDetected: ''
      });
    });
    
    const headers = [
      'orderId', 'orderNumber', 'orderDate', 'orderStatus',
      'shipToCity', 'shipToState',
      'itemIndex', 'itemName', 'itemSku', 'itemQty', 'itemUnitPrice',
      'currentCustomsDesc', 'currentCustomsHS', 'currentCustomsQty', 'currentCustomsValue',
      'suggestedDesc', 'suggestedHS',
      'matchMethod', 'productTypeDetected'
    ];
    
    const out = [csvLine(headers)];
    rows.forEach(r => out.push(csvLine(headers.map(h => r[h]))));
    
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const csv = out.join('\n');
    
    // Save backup copy locally
    try {
      const exportsDir = path.join(__dirname, '../exports');
      await fs.mkdir(exportsDir, { recursive: true });
      const filename = `shipstation_order_${order.orderNumber}_test_${stamp}.csv`;
      const filepath = path.join(exportsDir, filename);
      await fs.writeFile(filepath, csv);
      console.log(`✅ CSV saved locally: ${filepath}`);
    } catch (saveErr) {
      console.error('Failed to save backup:', saveErr);
    }
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipstation_order_${order.orderNumber}_test_${stamp}.csv"`);
    res.send(csv);
    
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

// Bulk export route (50 orders)
router.get('/api/shipstation/orders/export-bulk.csv', requireAuthApi, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const statuses = ['awaiting_payment', 'awaiting_shipment', 'on_hold', 'shipped'];
    
    console.log(`Starting bulk export: ${limit} US orders from last ${days} days`);
    
    // Collect US orders
    const orders = [];
    const seen = new Set();
    
    for (const status of statuses) {
      if (orders.length >= limit) break;
      
      let page = 1;
      const maxPages = 5;
      
      while (page <= maxPages && orders.length < limit) {
        await delay(1500); // Rate limit protection
        
        const list = await shipstation.searchOrders({
          modifyDateStart: since,
          orderStatus: status,
          sortBy: 'ModifyDate',
          sortDir: 'DESC',
          page,
          pageSize: 100
        });
        
        if (!list.length) break;
        
        for (const o of list) {
          if (orders.length >= limit) break;
          if (seen.has(o.orderId)) continue;
          seen.add(o.orderId);
          
          if (!isUS(o)) continue;
          
          await delay(100);
          const full = await shipstation.getOrder(o.orderId);
          orders.push(full);
          console.log(`  Added order ${orders.length}/${limit}: #${full.orderNumber}`);
        }
        
        if (list.length < 100) break;
        page++;
      }
    }
    
    console.log(`Processing ${orders.length} US orders for export`);
    
    // Build CSV rows for all orders
    const allRows = [];
    
    for (const order of orders) {
      const { canUpdate, analysis } = buildCustomsPatch(order);
      const items = Array.isArray(order.items) ? order.items : [];
      const customs = Array.isArray(order.internationalOptions?.customsItems) ? order.internationalOptions.customsItems : [];
      
      const availableCustomsIndices = new Set();
      customs.forEach((_, idx) => availableCustomsIndices.add(idx));
      
      let isFirstRowForOrder = true;
      
      // Process each item in the order
      items.forEach((item, itemIdx) => {
        const itemType = identifyProductFromTitle(item.name);
        
        let bestMatch = null;
        let bestIdx = -1;
        let matchMethod = 'NONE';
        
        // Find matching customs entry by product type
        for (const cidx of availableCustomsIndices) {
          const c = customs[cidx];
          const customsDesc = String(c.description || '').toLowerCase();
          const customsHS = getHS(c);
          
          let isMatch = false;
          let matchReason = '';
          
          // Product type matching logic
          if (itemType) {
            const correctForType = getCorrectHSAndDescription(itemType);
            
            if (correctForType && customsHS && normHS(customsHS) === normHS(correctForType.hs)) {
              isMatch = true;
              matchReason = `HS_${itemType}`;
            }
            else if (
              (itemType === 'notebook' && customsDesc.includes('notebook')) ||
              (itemType === 'planner' && customsDesc.includes('planner')) ||
              (itemType === 'sticker' && customsDesc.includes('sticker')) ||
              (itemType === 'sticky' && customsDesc.includes('sticky')) ||
              (itemType === 'insert' && (customsDesc.includes('insert') || customsDesc.includes('refill')))
            ) {
              isMatch = true;
              matchReason = `TYPE_${itemType}`;
            }
          }
          
          // Category-based fallback
          if (!isMatch) {
            const itemLower = String(item.name || '').toLowerCase();
            const categories = [
              { keywords: ['notebook', 'journal'], customsTerms: ['notebook', 'journal'] },
              { keywords: ['planner', 'agenda'], customsTerms: ['planner', 'agenda', 'diary'] },
              { keywords: ['sticky', 'post-it'], customsTerms: ['sticky', 'notepad'] },
              { keywords: ['sticker', 'tab'], customsTerms: ['sticker'] },
              { keywords: ['insert', 'refill'], customsTerms: ['insert', 'refill', 'loose'] }
            ];
            
            for (const cat of categories) {
              if (cat.keywords.some(k => itemLower.includes(k)) && 
                  cat.customsTerms.some(t => customsDesc.includes(t))) {
                isMatch = true;
                matchReason = `CAT_${cat.keywords[0]}`;
                break;
              }
            }
          }
          
          if (isMatch) {
            bestMatch = c;
            bestIdx = cidx;
            matchMethod = matchReason;
            break;
          }
        }
        
        // Fallback if no match
        if (!bestMatch && availableCustomsIndices.size > 0) {
          const firstAvailable = Array.from(availableCustomsIndices)[0];
          bestMatch = customs[firstAvailable];
          bestIdx = firstAvailable;
          matchMethod = 'FALLBACK';
        }
        
        if (bestIdx >= 0) {
          availableCustomsIndices.delete(bestIdx);
        }
        
        const bestAnalysis = bestIdx >= 0 ? analysis?.[bestIdx] : null;
        const productType = itemType || '';
        const correct = productType ? getCorrectHSAndDescription(productType) : null;
        
        allRows.push({
          // Order info - only on first row of each order
          orderId: isFirstRowForOrder ? order.orderId : '',
          orderNumber: isFirstRowForOrder ? order.orderNumber : '',
          orderDate: isFirstRowForOrder ? order.orderDate : '',
          orderStatus: isFirstRowForOrder ? order.orderStatus : '',
          shipToCity: isFirstRowForOrder ? (order?.shipTo?.city || '') : '',
          shipToState: isFirstRowForOrder ? (order?.shipTo?.state || '') : '',
          
          // Item details
          itemIndex: itemIdx,
          itemName: item?.name || '',
          itemSku: String(item?.sku || '').trim(),
          itemQty: item?.quantity || 1,
          itemUnitPrice: item?.unitPrice || '',
          
          // Matched customs
          currentCustomsDesc: bestMatch?.description || '',
          currentCustomsHS: bestMatch ? getHS(bestMatch) : '',
          currentCustomsQty: bestMatch?.quantity || '',
          currentCustomsValue: bestMatch?.value || '',
          
          // Suggestions
          suggestedDesc: correct?.desc || bestAnalysis?.mapped || '',
          suggestedHS: correct?.hs || bestAnalysis?.hsNew || '',
          
          // Metadata
          matchMethod: matchMethod,
          productTypeDetected: productType || ''
        });
        
        isFirstRowForOrder = false;
      });
      
      // Add unmatched customs as orphaned rows
      availableCustomsIndices.forEach(cidx => {
        const c = customs[cidx];
        allRows.push({
          orderId: '', orderNumber: '', orderDate: '', orderStatus: '', shipToCity: '', shipToState: '',
          itemIndex: '',
          itemName: '>>> UNMATCHED CUSTOMS <<<',
          itemSku: c.sku || '',
          itemQty: '',
          itemUnitPrice: '',
          currentCustomsDesc: c.description || '',
          currentCustomsHS: getHS(c) || '',
          currentCustomsQty: c.quantity || '',
          currentCustomsValue: c.value || '',
          suggestedDesc: '',
          suggestedHS: '',
          matchMethod: 'ORPHANED',
          productTypeDetected: ''
        });
      });
    }
    
    // Generate CSV
    const headers = [
      'orderId', 'orderNumber', 'orderDate', 'orderStatus',
      'shipToCity', 'shipToState',
      'itemIndex', 'itemName', 'itemSku', 'itemQty', 'itemUnitPrice',
      'currentCustomsDesc', 'currentCustomsHS', 'currentCustomsQty', 'currentCustomsValue',
      'suggestedDesc', 'suggestedHS',
      'matchMethod', 'productTypeDetected'
    ];
    
    const out = [csvLine(headers)];
    allRows.forEach(r => out.push(csvLine(headers.map(h => r[h]))));
    
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const csv = out.join('\n');
    
    // Save backup copy locally
    try {
      const exportsDir = path.join(__dirname, '../exports');
      await fs.mkdir(exportsDir, { recursive: true });
      const filename = `shipstation_${orders.length}_orders_${stamp}.csv`;
      const filepath = path.join(exportsDir, filename);
      await fs.writeFile(filepath, csv);
      console.log(`✅ CSV saved locally: ${filepath}`);
    } catch (saveErr) {
      console.error('Failed to save backup:', saveErr);
    }
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipstation_${orders.length}_orders_${stamp}.csv"`);
    res.send(csv);
    
    console.log(`Export complete: ${orders.length} orders, ${allRows.length} rows`);
    
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    console.error('Export error:', msg);
    res.status(status).json({ error: msg });
  }
});

// Export ALL US orders route - CORRECTED VERSION
router.get('/api/shipstation/orders/export-all.csv', requireAuthApi, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const maxOrders = Math.max(50, Math.min(5000, Number(req.query.limit || 2000)));
    
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const statuses = ['awaiting_payment', 'awaiting_shipment', 'on_hold', 'shipped', 'cancelled'];
    
    // Rate limiting: 40 calls per minute = 1 call every 1.5 seconds
    const API_DELAY = 1600; // milliseconds between API calls
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`BULK EXPORT: Fetching up to ${maxOrders} US orders from last ${days} days`);
    console.log(`Rate limit: 40 calls/min (${API_DELAY}ms between calls)`);
    console.log(`Estimated time: ${Math.round(maxOrders * API_DELAY / 60000)} minutes`);
    console.log(`${'='.repeat(70)}`);
    
    const startTime = Date.now();
    const orders = [];
    const seen = new Set();
    let totalScanned = 0;
    let apiCalls = 0;
    
    // First, collect order IDs from the list endpoints
    console.log('\nPhase 1: Collecting order IDs...');
    const orderIdsToFetch = [];
    
    for (const status of statuses) {
      if (orderIdsToFetch.length >= maxOrders) break;
      
      console.log(`\nScanning ${status} orders...`);
      let page = 1;
      const maxPages = 50;
      
      while (page <= maxPages && orderIdsToFetch.length < maxOrders) {
        await delay(API_DELAY);
        apiCalls++;
        
        if (apiCalls % 20 === 0) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`  [${elapsed}s] API calls: ${apiCalls}`);
        }
        
        const list = await shipstation.searchOrders({
          modifyDateStart: since,
          orderStatus: status,
          sortBy: 'ModifyDate',
          sortDir: 'DESC',
          page,
          pageSize: 200
        });
        
        if (!list.length) break;
        
        totalScanned += list.length;
        console.log(`  Page ${page}: ${list.length} orders`);
        
        for (const o of list) {
          if (orderIdsToFetch.length >= maxOrders) break;
          if (seen.has(o.orderId)) continue;
          seen.add(o.orderId);
          
          if (isUS(o)) {
            orderIdsToFetch.push(o.orderId);
          }
        }
        
        if (list.length < 200) break;
        page++;
      }
    }
    
    console.log(`\nPhase 1 complete: Found ${orderIdsToFetch.length} US orders (scanned ${totalScanned} total)`);
    
    // Phase 2: Fetch full order details
    console.log(`\nPhase 2: Fetching full order details...`);
    console.log(`This will take approximately ${Math.round(orderIdsToFetch.length * API_DELAY / 60000)} minutes`);
    
    for (let i = 0; i < orderIdsToFetch.length; i++) {
      await delay(API_DELAY);
      apiCalls++;
      
      const orderId = orderIdsToFetch[i];
      const full = await shipstation.getOrder(orderId);
      orders.push(full);
      
      // Progress updates
      if ((i + 1) % 10 === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const pct = Math.round((i + 1) / orderIdsToFetch.length * 100);
        const remaining = Math.round((orderIdsToFetch.length - i - 1) * API_DELAY / 60000);
        console.log(`  [${elapsed}s] ${i + 1}/${orderIdsToFetch.length} orders (${pct}%) - ~${remaining} min remaining`);
      }
    }
    
    const fetchTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`\nFetching complete in ${fetchTime} seconds (${apiCalls} API calls)`);
    console.log('Processing orders for CSV export...\n');
    
    // Build CSV rows
    const allRows = [];
    
    for (const order of orders) {
      const { canUpdate, analysis } = buildCustomsPatch(order);
      const items = Array.isArray(order.items) ? order.items : [];
      const customs = Array.isArray(order.internationalOptions?.customsItems) ? order.internationalOptions.customsItems : [];
      
      const availableCustomsIndices = new Set();
      customs.forEach((_, idx) => availableCustomsIndices.add(idx));
      
      let isFirstRowForOrder = true;
      
      // Process items
      items.forEach((item, itemIdx) => {
        const itemType = identifyProductFromTitle(item.name);
        
        let bestMatch = null;
        let bestIdx = -1;
        let matchMethod = 'NONE';
        
        // Match customs by product type
        for (const cidx of availableCustomsIndices) {
          const c = customs[cidx];
          const customsDesc = String(c.description || '').toLowerCase();
          const customsHS = getHS(c);
          
          let isMatch = false;
          let matchReason = '';
          
          if (itemType) {
            const correctForType = getCorrectHSAndDescription(itemType);
            
            if (correctForType && customsHS && normHS(customsHS) === normHS(correctForType.hs)) {
              isMatch = true;
              matchReason = `HS_${itemType}`;
            }
            else if (
              (itemType === 'notebook' && customsDesc.includes('notebook')) ||
              (itemType === 'planner' && customsDesc.includes('planner')) ||
              (itemType === 'sticker' && customsDesc.includes('sticker')) ||
              (itemType === 'sticky' && customsDesc.includes('sticky')) ||
              (itemType === 'insert' && (customsDesc.includes('insert') || customsDesc.includes('refill'))) ||
              (itemType === 'notepad' && customsDesc.includes('notepad'))
            ) {
              isMatch = true;
              matchReason = `TYPE_${itemType}`;
            }
          }
          
          if (!isMatch) {
            const itemLower = String(item.name || '').toLowerCase();
            const rules = [
              { item: ['notebook', 'journal'], customs: ['notebook', 'journal'] },
              { item: ['planner', 'agenda'], customs: ['planner', 'agenda', 'diary'] },
              { item: ['sticky'], customs: ['sticky', 'notepad'] },
              { item: ['sticker', 'tab'], customs: ['sticker'] },
              { item: ['insert', 'refill'], customs: ['insert', 'refill', 'loose'] }
            ];
            
            for (const rule of rules) {
              if (rule.item.some(k => itemLower.includes(k)) && 
                  rule.customs.some(t => customsDesc.includes(t))) {
                isMatch = true;
                matchReason = `KEY_${rule.item[0]}`;
                break;
              }
            }
          }
          
          if (isMatch) {
            bestMatch = c;
            bestIdx = cidx;
            matchMethod = matchReason;
            break;
          }
        }
        
        if (!bestMatch && availableCustomsIndices.size > 0) {
          const firstAvailable = Array.from(availableCustomsIndices)[0];
          bestMatch = customs[firstAvailable];
          bestIdx = firstAvailable;
          matchMethod = 'FALLBACK';
        }
        
        if (bestIdx >= 0) {
          availableCustomsIndices.delete(bestIdx);
        }
        
        const bestAnalysis = bestIdx >= 0 ? analysis?.[bestIdx] : null;
        const productType = itemType || '';
        const correct = productType ? getCorrectHSAndDescription(productType) : null;
        
        allRows.push({
          orderId: isFirstRowForOrder ? order.orderId : '',
          orderNumber: isFirstRowForOrder ? order.orderNumber : '',
          orderDate: isFirstRowForOrder ? (order.orderDate || '').split('T')[0] : '',
          orderStatus: isFirstRowForOrder ? order.orderStatus : '',
          shipToCity: isFirstRowForOrder ? (order?.shipTo?.city || '') : '',
          shipToState: isFirstRowForOrder ? (order?.shipTo?.state || '') : '',
          
          itemIndex: itemIdx,
          itemName: item?.name || '',
          itemSku: String(item?.sku || '').trim(),
          itemQty: item?.quantity || 1,
          itemUnitPrice: item?.unitPrice || '',
          
          currentCustomsDesc: bestMatch?.description || '',
          currentCustomsHS: bestMatch ? getHS(bestMatch) : '',
          currentCustomsQty: bestMatch?.quantity || '',
          currentCustomsValue: bestMatch?.value || '',
          
          suggestedDesc: correct?.desc || bestAnalysis?.mapped || '',
          suggestedHS: correct?.hs || bestAnalysis?.hsNew || '',
          
          matchMethod: matchMethod,
          productTypeDetected: productType || ''
        });
        
        isFirstRowForOrder = false;
      });
      
      // Orphaned customs
      availableCustomsIndices.forEach(cidx => {
        const c = customs[cidx];
        allRows.push({
          orderId: '', orderNumber: '', orderDate: '', orderStatus: '', 
          shipToCity: '', shipToState: '',
          itemIndex: '',
          itemName: '>>> UNMATCHED CUSTOMS <<<',
          itemSku: c.sku || '',
          itemQty: '',
          itemUnitPrice: '',
          currentCustomsDesc: c.description || '',
          currentCustomsHS: getHS(c) || '',
          currentCustomsQty: c.quantity || '',
          currentCustomsValue: c.value || '',
          suggestedDesc: '',
          suggestedHS: '',
          matchMethod: 'ORPHANED',
          productTypeDetected: ''
        });
      });
    }
    
    // Generate CSV
    const headers = [
      'orderId', 'orderNumber', 'orderDate', 'orderStatus',
      'shipToCity', 'shipToState',
      'itemIndex', 'itemName', 'itemSku', 'itemQty', 'itemUnitPrice',
      'currentCustomsDesc', 'currentCustomsHS', 'currentCustomsQty', 'currentCustomsValue',
      'suggestedDesc', 'suggestedHS',
      'matchMethod', 'productTypeDetected'
    ];
    
    const out = [csvLine(headers)];
    allRows.forEach(r => out.push(csvLine(headers.map(h => r[h]))));
    
    const totalTime = Math.round((Date.now() - startTime) / 60000);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    
    // Create the CSV string
    const csv = out.join('\n');
    
    // Save backup copy locally BEFORE sending response
    try {
      const exportsDir = path.join(__dirname, '../exports');
      await fs.mkdir(exportsDir, { recursive: true });
      const filename = `shipstation_ALL_${orders.length}_orders_${stamp}.csv`;
      const filepath = path.join(exportsDir, filename);
      await fs.writeFile(filepath, csv);
      console.log(`✅ CSV saved locally: ${filepath}`);
      console.log(`   To download: cat ${filepath} > ~/Desktop/${filename}`);
    } catch (saveErr) {
      console.error('Failed to save backup:', saveErr);
      // Continue even if save fails - don't block the download
    }
    
    // Send the response ONCE
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipstation_ALL_${orders.length}_orders_${stamp}.csv"`);
    res.send(csv);
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`EXPORT COMPLETE!`);
    console.log(`- ${orders.length} orders exported`);
    console.log(`- ${allRows.length} total CSV rows`);
    console.log(`- ${apiCalls} API calls made`);
    console.log(`- Total time: ${totalTime} minutes`);
    console.log(`${'='.repeat(70)}\n`);
    
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    console.error('Export error:', msg);
    
    if (status === 429) {
      console.error('Rate limit hit! Consider increasing delays.');
    }
    
    res.status(status).json({ error: msg });
  }
});

router.post('/api/shipstation/orders/:orderId/update', requireAuthApi, handleOrderUpdate);
router.get('/api/shipstation/orders/:orderId/update', requireAuthApi, handleOrderUpdate);

module.exports = router;