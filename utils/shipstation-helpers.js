// utils/shipstation-helpers.js
// ShipStation helper utilities

const OPEN_STATUSES = new Set(['awaiting_payment','awaiting_shipment','on_hold']);

function isOpen(order) {
  return OPEN_STATUSES.has(String(order.orderStatus || '').toLowerCase());
}

function isUS(order) {
  return String(order?.shipTo?.country || '').toUpperCase() === 'US';
}

// ISO-2 country coercion
function normCountry(c) {
  const s = String(c || '').trim().toUpperCase();
  if (s === 'CANADA') return 'CA';
  if (s === 'UNITED STATES' || s === 'USA') return 'US';
  return s.length > 2 ? s.slice(0,2) : s;
}

/**
 * IMPORTANT: keep any explicit `sku` we set on a customs item (including empty string).
 * Previously we dropped `sku`, which prevented us from detaching product linkage.
 */
function sanitizeCustomsItems(list = [], getHS) {
  return list.map(ci => {
    const qtyRaw = Number(ci?.quantity);
    const valRaw = Number(ci?.value);
    const hs = String(getHS(ci) || '').replace(/[^0-9]/g, '');

    const out = {
      description: String(ci?.description ?? '').slice(0, 255),
      quantity: Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.max(1, Math.floor(qtyRaw)) : 1,
      // Always send a positive value (1.00 for free items), never undefined or 0
      value: Number.isFinite(valRaw) && valRaw > 0 ? Number(valRaw.toFixed(2)) : 1.00,
      harmonizedTariffCode: hs || undefined,
      countryOfOrigin: normCountry(ci?.countryOfOrigin || ci?.country || 'CA')
    };

    // Preserve caller's intent to detach or set a SKU
    if ('sku' in ci) out.sku = String(ci.sku || '');

    return out;
  });
}

// Ensure required intl defaults are present when we send a patch
function ensureIntlDefaults(intl = {}) {
  const out = { ...intl };
  out.contents = out.contents || 'merchandise';
  out.nonDelivery = out.nonDelivery || 'return';
  if (typeof out.customsCertify !== 'boolean') out.customsCertify = true;
  if (!out.customsSigner) out.customsSigner = 'Hemlock & Oak';
  return out;
}

// Flatten ShipStation ModelState into a readable string
function formatShipStationError(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  let details = '';
  if (data?.ModelState && typeof data.ModelState === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(data.ModelState)) {
      parts.push(`${k}: ${Array.isArray(v) ? v.join(' | ') : String(v)}`);
    }
    details = parts.join('  •  ');
  }
  const message = details || data?.Message || data?.message || (typeof data === 'string' ? data : '') || e.message || 'Request failed';
  return { status, message };
}

// CSV export utilities
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(arr) { return arr.map(csvCell).join(','); }

module.exports = {
  OPEN_STATUSES,
  isOpen,
  isUS,
  normCountry,
  sanitizeCustomsItems,
  ensureIntlDefaults,
  formatShipStationError,
  csvCell,
  csvLine
};
