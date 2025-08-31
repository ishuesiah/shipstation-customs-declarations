// public/app.js
(() => {
  'use strict';

  // ===== State ==============================================================
  let products = [];
  let modifiedData = new Map();
  let duplicateSkus = new Set();
  let selectedIds = new Set(); // rows chosen for Save
  let baseline = new Map();    // ORIGINAL values at last refresh (for accurate diffing)
  let HS_MAP = new Map();      // HS → { desc, country }

  // Expose functions used by inline HTML (buttons/onclicks)
  window.refreshProducts = refreshProducts;
  window.saveChanges = saveChanges;
  window.makeEditable = makeEditable;
  window.toggleSelect = toggleSelect;
  window.filterTable = filterTable;
  window.showErrors = showErrors;
  window.closeErrors = closeErrors;
  window.generateSkusForDuplicates = generateSkusForDuplicates;
  window.generateSkusForMissing = generateSkusForMissing;
  window.exportShipStationCSV = exportShipStationCSV;
  window.promptLoadHsMap = promptLoadHsMap;   // optional UI hook
  window.HS_MAP = HS_MAP;                     // handy for debugging in DevTools

  // ===== Boot ===============================================================
  document.addEventListener('DOMContentLoaded', () => {
    const dupCb = document.getElementById('showDuplicatesOnly');
    const missCb = document.getElementById('showMissingOnly');
    const modCb = document.getElementById('showModifiedOnly');

    // Make them mutually exclusive (tab-like)
    const syncTabs = (changed) => {
      if (changed === dupCb && dupCb.checked) { missCb.checked = false; modCb.checked = false; }
      if (changed === missCb && missCb.checked){ dupCb.checked = false; modCb.checked = false; }
      if (changed === modCb && modCb.checked) { dupCb.checked = false; missCb.checked = false; }
      filterTable();
    };
    [dupCb, missCb, modCb].forEach(cb => cb && cb.addEventListener('change', () => syncTabs(cb)));

    // Try loading any cached HS map
    (function bootstrapHsMapFromStorage() {
      try {
        const raw = localStorage.getItem('HS_MAP_CSV_RAW');
        if (raw) loadHsMapFromCSV(raw);
      } catch {}
    })();

    refreshProducts();
  });
  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
      ...opts
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // HTML came back (likely a redirect to /login)
      throw new Error(`HTTP ${res.status} — non-JSON response: ${text.slice(0,120)}`);
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  
  // wherever you load products:
  async function loadProducts() {
    try {
      const { products, duplicates } = await fetchJSON('/api/products');
      // ... your existing render code here ...
    } catch (e) {
      // show the message in your status bar
      showStatus(`Failed to load products: ${e.message}`, 'error');
    }
  }
  
  // ===== Data refresh & render =============================================
  async function refreshProducts() {
    const loading = document.getElementById('loading');
    const statusBar = document.getElementById('statusBar');
    const statusMessage = document.getElementById('statusMessage');

    loading.classList.add('active');
    statusBar.className = 'status-bar';

    try {
      const response = await fetch('/api/products');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      products = data.products;
      duplicateSkus = new Set(data.duplicates);
      modifiedData.clear();

      // Build ORIGINAL baseline snapshot for accurate diffs later
      baseline.clear();
      products.forEach(p => p.variants.forEach(v => {
        baseline.set(String(v.id), {
          sku: (v.sku ?? ''),
          price: (v.price === undefined || v.price === null) ? '' : String(v.price),
          weight: (v.weight === undefined || v.weight === null) ? '' : String(v.weight),
          harmonized_system_code: (v.harmonized_system_code ?? ''),
          country_code_of_origin: (v.country_code_of_origin ?? '')
        });
      }));

      renderTable();
      updateStats();

      statusBar.className = 'status-bar active success';
      statusMessage.textContent = `Loaded ${products.length} products successfully`;
      setTimeout(() => { statusBar.className = 'status-bar'; }, 3000);
    } catch (error) {
      statusBar.className = 'status-bar active error';
      statusMessage.textContent = 'Failed to load products: ' + error.message;
    } finally {
      loading.classList.remove('active');
    }
  }

  function renderTable() {
    const tbody = document.getElementById('productTableBody');
    tbody.innerHTML = '';

    products.forEach(product => {
      product.variants.forEach(variant => {
        const row = tbody.insertRow();
        const variantId = String(variant.id); // normalize to string

        // Staged (unsaved) edits for this variant
        const staged = modifiedData.get(variantId) || {};
        const getVal = (field, fallback = '') =>
          (staged[field] !== undefined ? staged[field] : (variant[field] ?? fallback));

        const rawSku  = getVal('sku', '') || '';
        const sku     = String(rawSku).trim();
        const price   = getVal('price', '') === '' ? '' : String(getVal('price'));
        const weight  = getVal('weight', '') === '' ? '' : String(getVal('weight'));
        const hs      = getVal('harmonized_system_code', '') || '';
        const country = getVal('country_code_of_origin', '') || '';

        const isDuplicate = !!sku && duplicateSkus.has(sku);
        const isMissing   = !sku;

        // Select (persist checked state)
        const checkCell = row.insertCell();
        checkCell.innerHTML =
          `<input type="checkbox" class="select-for-update" data-variant-id="${variantId}" onchange="toggleSelect(this)">`;
        const cb = checkCell.querySelector('input');
        if (selectedIds.has(variantId)) cb.checked = true;

        // Status
        const statusCell = row.insertCell();
        if (isMissing)   statusCell.innerHTML = '<span class="missing-indicator">MISSING</span>';
        else if (isDuplicate) statusCell.innerHTML = '<span class="duplicate-indicator">DUPLICATE</span>';

        // Titles
        row.insertCell().textContent = product.title;
        row.insertCell().textContent = variant.title || 'Default';

        // SKU (editable)
        const skuCell = row.insertCell();
        skuCell.className = (isDuplicate || isMissing) ? 'editable sku-error' : 'editable';
        skuCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'sku')" data-variant-id="${variantId}" data-field="sku" class="editable-span">${sku}</span>`;
        if (staged.sku !== undefined) skuCell.classList.add('cell-modified');

        // Price (editable)
        const priceCell = row.insertCell();
        priceCell.className = 'editable';
        priceCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'price')">${price !== '' ? '$' + price : ''}</span>`;
        if (staged.price !== undefined) priceCell.classList.add('cell-modified');

        // Inventory (read-only)
        row.insertCell().textContent = variant.inventory_quantity || '0';

        // Weight (editable)
        const weightCell = row.insertCell();
        weightCell.className = 'editable';
        weightCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'weight')">${weight !== '' ? weight : ''}</span>`;
        if (staged.weight !== undefined) weightCell.classList.add('cell-modified');

        // HS Code (editable)
        const hsCell = row.insertCell();
        hsCell.className = 'editable';
        hsCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'harmonized_system_code')">${hs}</span>`;
        if (staged.harmonized_system_code !== undefined) hsCell.classList.add('cell-modified');

        // Country (editable)
        const countryCell = row.insertCell();
        countryCell.className = 'editable';
        countryCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'country_code_of_origin')">${country}</span>`;
        if (staged.country_code_of_origin !== undefined) countryCell.classList.add('cell-modified');

        // Row metadata for search/filter
        row.dataset.variantId    = variantId;
        row.dataset.productTitle = product.title.toLowerCase();
        row.dataset.variantTitle = (variant.title || '').toLowerCase();
        row.dataset.sku          = (sku || '').toLowerCase();
      });
    });

    // Re-apply filters after any render
    filterTable();
  }

  // ===== Table interactions =================================================
  function toggleSelect(el) {
    const id = String(el.dataset.variantId);
    if (el.checked) selectedIds.add(id);
    else selectedIds.delete(id);
  }

  function makeEditable(span, variantId, field) {
    let raw = span.textContent.trim();
    if (field === 'price') raw = raw.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');

    const input = document.createElement('input');
    input.type = (field === 'price' || field === 'weight') ? 'number' : 'text';
    if (field === 'price')  input.step = '0.01';
    if (field === 'weight') input.step = '1';

    if (field === 'price' || field === 'weight') {
      const n = raw === '' ? '' : Number(raw);
      input.value = Number.isFinite(n) ? String(n) : '';
    } else {
      input.value = raw;
    }

    // Commit on blur and on Enter
    input.onblur = () => saveEdit(input, span, String(variantId), field);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };

    const cell = span.parentElement;
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();
  }

  function patchLocalVariant(variantId, field, value) {
    // Keep UI responsive by reflecting staged values in the local table,
    // but remember: diffs are computed against 'baseline' (not 'products').
    const vid = String(variantId);
    for (const p of products) {
      for (const v of p.variants) {
        if (String(v.id) === vid) {
          if (field === 'price') v.price = (value === '' ? '' : Number(value));
          else if (field === 'weight') v.weight = (value === '' ? '' : Number(value));
          else v[field] = value; // sku, harmonized_system_code, country_code_of_origin
          return;
        }
      }
    }
  }

  function saveEdit(input, originalSpan, variantId, field) {
    let newValue = input.value;

    if (field === 'price' || field === 'weight') {
      newValue = newValue === '' ? '' : String(Number(newValue));
      if (newValue !== '' && !Number.isFinite(Number(newValue))) {
        const cell = input.parentElement;
        const prev = originalSpan.textContent;
        cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', '${field}')">${prev}</span>`;
        return;
      }
    } else if (field === 'sku') {
      newValue = newValue.trim();
    }

    const key = String(variantId);
    if (!modifiedData.has(key)) modifiedData.set(key, {});
    modifiedData.get(key)[field] = newValue;

    patchLocalVariant(key, field, newValue);

    const cell = input.parentElement;
    let display = newValue;
    if (field === 'price' && newValue !== '') display = '$' + newValue;
    cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', '${field}')">${display}</span>`;
    cell.classList.add('cell-modified');

    // If SKU changed, recompute duplicates and rerender (filters reapplied)
    if (field === 'sku') {
      recomputeDuplicateSet();
      renderTable();
    }

    updateStats();
  }

  function recomputeDuplicateSet() {
    const skuCounts = {};
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const s = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      const norm = String(s || '').trim();
      if (norm) skuCounts[norm] = (skuCounts[norm] || 0) + 1;
    }));
    duplicateSkus.clear();
    Object.entries(skuCounts).forEach(([s, c]) => { if (c > 1) duplicateSkus.add(s); });
  }

  function updateStats() {
    const uniqueSkusSet = new Set();
    const skuCounts = {};
    let missing = 0;

    products.forEach(product => {
      product.variants.forEach(variant => {
        const vid = String(variant.id);
        let sku = variant.sku;
        if (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined) {
          sku = modifiedData.get(vid).sku;
        }
        const norm = String(sku || '').trim();
        if (!norm) {
          missing++;
        } else {
          uniqueSkusSet.add(norm);
          skuCounts[norm] = (skuCounts[norm] || 0) + 1;
        }
      });
    });

    const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
    const duplicateCount = Object.values(skuCounts).filter(count => count > 1).length;

    document.getElementById('totalProducts').textContent = totalVariants;
    document.getElementById('uniqueSkus').textContent = uniqueSkusSet.size;
    document.getElementById('duplicateSkus').textContent = duplicateCount;
    document.getElementById('missingSkus').textContent = missing;
    document.getElementById('modifiedCount').textContent = modifiedData.size;
  }

  function filterTable() {
    const searchValue = document.getElementById('searchInput').value.toLowerCase();
    const showDuplicates = document.getElementById('showDuplicatesOnly').checked;
    const showMissing = document.getElementById('showMissingOnly').checked;
    const showModified = document.getElementById('showModifiedOnly').checked;

    const rows = document.querySelectorAll('#productTableBody tr');

    rows.forEach(row => {
      const variantId = row.dataset.variantId;
      const isDuplicate = row.querySelector('.duplicate-indicator') !== null;
      const isMissing = row.querySelector('.missing-indicator') !== null;
      const isModified = modifiedData.has(variantId);

      let showRow = true;

      if (searchValue) {
        const searchableText = row.dataset.productTitle + ' ' +
                               row.dataset.variantTitle + ' ' +
                               row.dataset.sku;
        showRow = searchableText.includes(searchValue);
      }

      // Tab-like logic (mutually exclusive)
      if (showRow && showDuplicates) showRow = isDuplicate;
      if (showRow && showMissing)    showRow = isMissing;
      if (showRow && showModified)   showRow = isModified;

      row.style.display = showRow ? '' : 'none';
    });
  }

  function getVisibleVariantIds() {
    // Variant IDs for rows currently visible in the table
    const rows = Array.from(document.querySelectorAll('#productTableBody tr'));
    const ids = [];
    rows.forEach(row => {
      const display = window.getComputedStyle(row).display;
      if (display !== 'none') ids.push(String(row.dataset.variantId));
    });
    return ids;
  }

  // ===== Save logic (accurate diffs) ========================================
  function buildDiffPayload(variantId) {
    // Use staged edits, but drop fields that didn't actually change vs ORIGINAL baseline
    const id = String(variantId);
    const staged = modifiedData.get(id);
    if (!staged || Object.keys(staged).length === 0) return null;

    const orig = baseline.get(id) || {};
    const diff = {};
    for (const [k, val] of Object.entries(staged)) {
      const normNew  = (k === 'price' || k === 'weight') ? String(val ?? '') : String(val ?? '').trim();
      const normOrig = (k === 'price' || k === 'weight') ? String(orig[k] ?? '') : String((orig[k] ?? '')).trim();
      if (normNew !== normOrig) diff[k] = val;
    }
    if (Object.keys(diff).length === 0) return null;
    return { id, ...diff };
  }

  async function saveChanges() {
    // Commit any in-progress edit (so staged value is captured)
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
    }

    const saveBtn = document.getElementById('saveBtn');
    const selected = Array.from(selectedIds);
    const showModified = document.getElementById('showModifiedOnly').checked;

    // Scope:
    // 1) If user selected rows, selection wins
    // 2) Else if "Show Modified Only" tab is active, save only visible rows
    // 3) Else, save all staged edits
    let idsToConsider;
    if (selected.length > 0) {
      idsToConsider = selected;
    } else if (showModified) {
      idsToConsider = getVisibleVariantIds();
    } else {
      idsToConsider = Array.from(modifiedData.keys());
    }

    // Build update entries: only variants that (a) have staged edits and (b) actually differ from baseline
    const updates = [];
    idsToConsider.forEach(id => {
      const payload = buildDiffPayload(id);
      if (payload) updates.push(payload);
    });

    if (updates.length === 0) {
      showStatus('Nothing to save for this view.', 'warning');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const response = await fetch('/api/products/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);

      showStatus(`Successfully updated ${result.updated} variants`, 'success');

      // Clear only what we sent; keep other staged edits intact
      updates.forEach(u => {
        modifiedData.delete(String(u.id));
        selectedIds.delete(String(u.id));
      });

      setTimeout(() => refreshProducts(), 800);
    } catch (error) {
      showStatus('Failed to save: ' + error.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Changes to Shopify';
    }
  }

  // ===== Status & errors =====================================================
  function showStatus(message, type) {
    const statusBar = document.getElementById('statusBar');
    const statusMessage = document.getElementById('statusMessage');
    statusBar.className = `status-bar active ${type}`;
    statusMessage.textContent = message;
    setTimeout(() => { statusBar.className = 'status-bar'; }, 5000);
  }

  function showErrors() {
    document.getElementById('errorPanel').classList.add('open');
  }
  function closeErrors() {
    document.getElementById('errorPanel').classList.remove('open');
  }

  // ===== Generators ==========================================================
  function generateSkusForDuplicates() {
    if (!window.SKUGenerator || !window.SKU_RULES) {
      showStatus('SKU generator not loaded', 'error');
      return;
    }
    const stagedSku = (v) => {
      const vid = String(v.id);
      return (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
    };

    // Build groups: sku -> [{ p, v }]
    const groups = new Map();
    products.forEach(p => p.variants.forEach(v => {
      const s = String(stagedSku(v) || '').trim().toUpperCase();
      if (!s) return;
      groups.set(s, (groups.get(s) || []).concat({ p, v }));
    }));

    // Only groups with >1 are duplicates
    const dupGroups = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1);
    if (dupGroups.length === 0) {
      showStatus('No duplicates found to generate.', 'warning');
      return;
    }

    // Set of currently used SKUs (live + staged), normalized uppercase
    const used = new Set();
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const s = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      const norm = String(s || '').trim();
      if (norm) used.add(norm.toUpperCase());
    }));

    const gen = new window.SKUGenerator(window.SKU_RULES, { maxLength: 20, imperfectCode: 'IM' });
    let changed = 0;

    for (const [skuKey, arr] of dupGroups) {
      arr.sort((a, b) => String(a.v.id).localeCompare(String(b.v.id)));
      used.add(skuKey.toUpperCase()); // keep first as-is

      for (let i = 1; i < arr.length; i++) {
        const { p, v } = arr[i];
        const options = [v.option1, v.option2, v.option3].filter(Boolean);

        const suggestion = gen.generate(
          p.title,
          v.title || '',
          cand => used.has(String(cand).toUpperCase()),
          options
        );
        if (!suggestion) continue;

        const vid = String(v.id);
        if (!modifiedData.has(vid)) modifiedData.set(vid, {});
        modifiedData.get(vid).sku = suggestion;
        patchLocalVariant(vid, 'sku', suggestion);

        used.add(String(suggestion).toUpperCase());
        changed++;
      }
    }

    recomputeDuplicateSet();
    renderTable();
    updateStats();
    filterTable();
    showStatus(
      changed ? `Generated ${changed} SKUs to resolve duplicates` : 'No new SKUs were generated',
      changed ? 'success' : 'warning'
    );
  }

  function generateSkusForMissing() {
    if (!window.SKUGenerator || !window.SKU_RULES) {
      showStatus('SKU generator not loaded', 'error');
      return;
    }

    // Set of currently used SKUs (live + staged), normalized uppercase
    const used = new Set();
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      let s = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      s = String(s || '').trim();
      if (s) used.add(s.toUpperCase());
    }));

    const gen = new window.SKUGenerator(window.SKU_RULES, { maxLength: 20, imperfectCode: 'IM' });
    let changed = 0;

    // For every variant with missing SKU, generate a unique one
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const staged = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      const current = String(staged || '').trim();

      if (current) return; // not missing

      const options = [v.option1, v.option2, v.option3].filter(Boolean);

      const suggestion = gen.generate(
        p.title,
        v.title || '',
        cand => used.has(String(cand).toUpperCase()),
        options
      );
      if (!suggestion) return;

      if (!modifiedData.has(vid)) modifiedData.set(vid, {});
      modifiedData.get(vid).sku = suggestion;
      patchLocalVariant(vid, 'sku', suggestion);

      used.add(String(suggestion).toUpperCase());
      changed++;
    }));

    recomputeDuplicateSet();
    renderTable();
    updateStats();
    filterTable();
    showStatus(
      changed ? `Generated ${changed} SKUs for missing variants` : 'No missing SKUs found to generate',
      changed ? 'success' : 'warning'
    );
  }

  // ===== ShipStation CSV export (with HS map) ===============================
  function exportShipStationCSV() {
    // Columns expected by ShipStation (from ProductImportSample.csv)
    const headers = [
      'SKU','Name','WarehouseLocation','WeightOz','Category','Tag1','Tag2','Tag3','Tag4','Tag5',
      'CustomsDescription','CustomsValue','CustomsTariffNo','CustomsCountry','ThumbnailUrl','UPC',
      'FillSKU','Length','Width','Height','UseProductName','Active','ParentSKU','IsReturnable'
    ];

    const selected = Array.from(selectedIds);
    const visibleSet = new Set(getVisibleVariantIds());
    const shouldInclude = (vid) => selected.length > 0 ? selected.includes(vid) : visibleSet.has(vid);

    const toOz = (grams) => {
      const n = Number(grams);
      if (!Number.isFinite(n)) return '';
      return Math.round(n * 0.03527396195 * 100) / 100; // 2 decimals
    };

    const rows = [];
    products.forEach(p => p.variants.forEach(v => {
      const id = String(v.id);
      if (!shouldInclude(id)) return;

      const staged = modifiedData.get(id) || {};
      const sku = (staged.sku !== undefined ? staged.sku : v.sku) || '';
      if (!sku.trim()) return; // ShipStation requires SKU

      const price   = staged.price !== undefined ? staged.price : v.price;
      const weight  = staged.weight !== undefined ? staged.weight : v.weight; // grams
      const hs      = staged.harmonized_system_code !== undefined ? staged.harmonized_system_code : v.harmonized_system_code;
      let origin    = staged.country_code_of_origin !== undefined ? staged.country_code_of_origin : v.country_code_of_origin;

      const name = (v.title && v.title !== 'Default') ? `${p.title} — ${v.title}` : p.title;

      const tagsArr = (p.tags || '').split(',').map(s => s.trim()).filter(Boolean);
      const [tag1, tag2, tag3, tag4, tag5] = [tagsArr[0]||'', tagsArr[1]||'', tagsArr[2]||'', tagsArr[3]||'', tagsArr[4]||''];

      // Try variant image; else product image
      let thumb = '';
      if (v.image_id && Array.isArray(p.images)) {
        const hit = p.images.find(img => String(img.id) === String(v.image_id));
        thumb = hit?.src || '';
      } else {
        thumb = p.image?.src || '';
      }

      const upc = v.barcode || '';

      // Customs description via HS map (if available)
      let customsDesc = name;
      if (hs) {
        const key1 = String(hs).trim();
        const key2 = normalizeHs(hs);
        const dotted = addDotsToHs(key2);
        const hit = HS_MAP.get(key1) || HS_MAP.get(key2) || (dotted ? HS_MAP.get(dotted) : undefined);
        if (hit?.desc) customsDesc = hit.desc;
        if (!origin && hit?.country) origin = hit.country;
      }

      const rec = {
        SKU: sku,
        Name: name,
        WarehouseLocation: '',
        WeightOz: toOz(weight),
        Category: p.product_type || '',
        Tag1: tag1, Tag2: tag2, Tag3: tag3, Tag4: tag4, Tag5: tag5,
        CustomsDescription: customsDesc,
        CustomsValue: (price === '' || price === undefined || price === null) ? '' : String(price),
        CustomsTariffNo: hs || '',
        CustomsCountry: origin ? String(origin).toUpperCase() : '',
        ThumbnailUrl: thumb,
        UPC: upc,
        FillSKU: '',
        Length: '', Width: '', Height: '',
        UseProductName: '',     // blank => use Name
        Active: 'True',
        ParentSKU: '',
        IsReturnable: 'True'
      };

      rows.push(rec);
    }));

    const esc = (val) => {
      let s = (val === null || val === undefined) ? '' : String(val);
      if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => esc(r[h])).join(','))
    ].join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0,10);
    a.download = `shipstation_products_${date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const mode = selected.length > 0 ? 'selected rows' : 'visible rows';
    showStatus(`Exported ${rows.length} rows to ShipStation CSV (${mode})`, 'success');
  }

  // ===== HS map loader (CSV) ================================================
  function promptLoadHsMap() {
    const inp = document.getElementById('hsMapFile');
    if (!inp) return showStatus('HS map input not found', 'error');
    inp.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        loadHsMapFromCSV(text);
        localStorage.setItem('HS_MAP_CSV_RAW', text);
        showStatus(`HS map loaded: ${HS_MAP.size} codes`, 'success');
      } catch (err) {
        showStatus('Failed to load HS map: ' + err.message, 'error');
      } finally {
        e.target.value = '';
      }
    };
    inp.click();
  }

  function loadHsMapFromCSV(csvText) {
    HS_MAP.clear();
    const rows = parseCSV(csvText);
    if (!rows || rows.length === 0) return;

    // Find column indices by header names (flexible)
    const hdr = rows[0].map(h => String(h).trim().toLowerCase());
    const idxDesc = hdr.findIndex(h => h.includes('description'));
    const idxHS   = hdr.findIndex(h => h.includes('hs') && h.includes('code'));
    const idxCtr  = hdr.findIndex(h => h.includes('country') && h.includes('origin'));

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const hs = normalizeHs(r[idxHS] || '');
      if (!hs) continue;
      const desc = String(r[idxDesc] || '').trim();
      const country = String(r[idxCtr] || '').trim();
      HS_MAP.set(hs, { desc, country });
      // also accept dotted key (e.g., 4820.10.2010)
      const dotted = addDotsToHs(hs);
      if (dotted) HS_MAP.set(dotted, { desc, country });
    }
  }

  function normalizeHs(val) {
    return String(val || '').replace(/[^0-9]/g, '');
  }
  function addDotsToHs(digits) {
    const s = String(digits || '').replace(/[^0-9]/g, '');
    // e.g., 4820102010 -> 4820.10.2010
    if (s.length === 10) return `${s.slice(0,4)}.${s.slice(4,6)}.${s.slice(6)}`;
    return '';
  }

  function parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const rows = [];
    for (const line of lines) {
      if (line.trim() === '') { rows.push(['']); continue; }
      const cells = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { inQ = false; }
          else { cur += ch; }
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ',') { cells.push(cur); cur = ''; }
          else { cur += ch; }
        }
      }
      cells.push(cur);
      rows.push(cells);
    }
    // Drop trailing empty rows
    while (rows.length && rows[rows.length-1].every(c => String(c).trim() === '')) rows.pop();
    return rows;
  }

})();
