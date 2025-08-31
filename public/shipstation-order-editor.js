'use strict';

(() => {
  // --- DOM
  const orderInput = document.getElementById('orderId');
  const btnPreview = document.getElementById('btnPreview');
  const btnApply = document.getElementById('btnApply');
  const statusEl = document.getElementById('status');
  const diffBox = document.getElementById('diffBox');

  // Bulk controls
  const bulkDaysEl = document.getElementById('bulkDays');
  const bulkPageSizeEl = document.getElementById('bulkPageSize');
  const bulkMaxPagesEl = document.getElementById('bulkMaxPages');
  const btnBulkPreview = document.getElementById('btnBulkPreview');
  const btnBulkApply = document.getElementById('btnBulkApply');
  const bulkStatus = document.getElementById('bulkStatus');
  const bulkTbody = document.getElementById('bulkTbody');
  const bulkSelectAll = document.getElementById('bulkSelectAll');

  // Export buttons
  const btnExportMismatches = document.getElementById('btnExportMismatches');
  const btnExportAll = document.getElementById('btnExportAll');

  // --- helpers
  const showBulk = (msg, kind='ok') => {
    bulkStatus.textContent = msg;
    bulkStatus.className = `status show ${kind === 'ok' ? 'ok' : 'err'}`;
  };
  const show = (msg, kind='ok') => {
    statusEl.textContent = msg;
    statusEl.className = `status show ${kind === 'ok' ? 'ok' : 'err'}`;
  };

  // Always include cookies; robust JSON parsing; friendly network errors
  async function fetchJSON(url, opts = {}) {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'no-store', ...opts });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { error: text || 'Non-JSON response' }; }
      data._ok = res.ok;
      data._status = res.status;
      if (res.status === 401) {
        // session expired → bounce
        window.location.href = '/login';
      }
      return data;
    } catch (err) {
      return { _ok: false, _status: 0, error: 'Network error (request blocked or server down).' };
    }
  }

  function renderBulkTable(candidates) {
    bulkTbody.innerHTML = '';
    (candidates || []).forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="padding:.5rem;"><input type="checkbox" class="bulk-row" data-id="${c.orderId}"></td>
        <td style="padding:.5rem;">#${c.orderNumber || c.orderId}</td>
        <td style="padding:.5rem;">${(c.shipTo?.city || '')}, ${(c.shipTo?.state || '')}</td>
        <td style="padding:.5rem;">${c.changes}</td>
        <td style="padding:.5rem; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85rem;">
          ${Array.isArray(c.diff) ? c.diff.map(d => {
            const arrow = (d.harmonizedCodeNew && d.harmonizedCodeNew !== d.harmonizedCode)
              ? ' → ' + d.harmonizedCodeNew : '';
            return `[HS ${d.harmonizedCode || ''}${arrow}] "${d.from}" → "${d.to}"`;
          }).join('<br>') : ''}
        </td>
      `;
      bulkTbody.appendChild(tr);
    });
    btnBulkApply.disabled = !(candidates && candidates.length);
  }

  // ---- EVENTS: bulk scan
  btnBulkPreview?.addEventListener('click', async () => {
    btnBulkApply.disabled = true;
    if (bulkSelectAll) bulkSelectAll.checked = false;
    bulkTbody.innerHTML = '';
    try {
      const qs = new URLSearchParams({
        days: String(bulkDaysEl?.value || 30),
        pageSize: String(bulkPageSizeEl?.value || 100),
        maxPages: String(bulkMaxPagesEl?.value || 5)
      }).toString();
      showBulk('Scanning open US orders…', 'ok');
      const data = await fetchJSON(`/api/shipstation/orders/scan?${qs}`);
      if (!data._ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${data._status}`);
      renderBulkTable(data.candidates || []);
      showBulk(`Found ${data.totalCandidates} orders with mismatched customs descriptions in the last ${data.scannedDays} days.`, 'ok');
    } catch (e) {
      showBulk(e.message || 'Scan failed', 'err');
    }
  });

  bulkSelectAll?.addEventListener('change', () => {
    document.querySelectorAll('.bulk-row').forEach(cb => { cb.checked = bulkSelectAll.checked; });
  });

  btnBulkApply?.addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('.bulk-row:checked')).map(cb => cb.dataset.id);
    if (!ids.length) return showBulk('Select at least one order.', 'err');

    showBulk(`Applying fixes to ${ids.length} orders…`, 'ok');
    btnBulkApply.disabled = true;
    try {
      const resp = await fetchJSON('/api/shipstation/orders/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: ids })
      });
      if (!resp._ok) throw new Error(typeof resp.error === 'string' ? resp.error : `HTTP ${resp._status}`);
      const ok = resp.updated || 0;
      const fail = resp.failed || 0;
      showBulk(`Done. Updated ${ok} orders, ${fail} failed. See console for details.`, 'ok');
      console.log('Bulk results:', resp.results);
    } catch (e) {
      showBulk(e.message || 'Bulk update failed', 'err');
    } finally {
      btnBulkApply.disabled = false;
    }
  });

  // ---- EVENTS: single preview/apply
  let lastOrderId = null;

  btnPreview?.addEventListener('click', async () => {
    btnApply.disabled = true;
    const id = (orderInput?.value || '').trim();
    if (!id) return show('Enter a ShipStation orderId or orderNumber.', 'err');

    try {
      const data = await fetchJSON(`/api/shipstation/orders/${encodeURIComponent(id)}/preview`);
      if (!data._ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${data._status}`);
      lastOrderId = id;
      renderDiffAndAnalysis(data.diff, data.analysis);
      const changesPlanned = (data.diff?.length || 0); // focus on customs Desc/HS only
      btnApply.disabled = changesPlanned === 0;
      show(`Preview ready. ${changesPlanned} change(s) planned.`, 'ok');
    } catch (e) {
      show(e.message || 'Preview failed', 'err');
      diffBox.textContent = '// error';
    }
  });

  btnApply?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!lastOrderId) return;
    try {
      const data = await fetchJSON(`/api/shipstation/orders/${encodeURIComponent(lastOrderId)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!data._ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${data._status}`);
      show(`Updated order ${data.updatedOrderId}. Descriptions changed: ${data.changedDescriptions}.`, 'ok');
    } catch (e) {
      show(e.message || 'Update failed', 'err');
    }
  });

  // ---- EVENTS: exports (CSV)
  btnExportMismatches?.addEventListener('click', () => {
    const qs = new URLSearchParams({
      days: String(bulkDaysEl?.value || 30),
      pageSize: String(bulkPageSizeEl?.value || 100),
      maxPages: String(bulkMaxPagesEl?.value || 5),
      scope: 'mismatched',
      mode: 'item'
    }).toString();
    window.location.href = `/api/shipstation/orders/export.csv?${qs}`;
  });

  btnExportAll?.addEventListener('click', () => {
    const qs = new URLSearchParams({
      days: String(bulkDaysEl?.value || 30),
      pageSize: String(bulkPageSizeEl?.value || 100),
      maxPages: String(bulkMaxPagesEl?.value || 5),
      scope: 'all',
      mode: 'item',
      statuses: 'awaiting_payment,awaiting_shipment,on_hold,shipped,delivered'
    }).toString();
    window.location.href = `/api/shipstation/orders/export.csv?${qs}`;
  });

  // -------- renderer ----------
  function renderDiffAndAnalysis(diff, analysis) {
    const lines = [];
    if (Array.isArray(analysis) && analysis.length) {
      lines.push('// Analysis of customs items:');
      analysis.forEach(a => {
        const hsNote = a.hsNew && a.hsNew !== a.hs ? ` HS ${a.hs} → ${a.hsNew}` : ` HS ${a.hs}`;
        lines.push(`#${a.index + 1}${hsNote} rule=${a.rule} FROM: "${a.from}"  ->  TO: "${a.mapped}"  ${a.willChange ? '🎯 CHANGE' : '— no change'}`);
      });
      lines.push('');
    }

    if (!diff || diff.length === 0) {
      lines.push('// No customs description or HS code changes would be made.');
    } else {
      lines.push('// Pending changes:');
      diff.forEach(d => {
        const hsLabel = d.harmonizedCodeNew && d.harmonizedCodeNew !== d.harmonizedCode
          ? `[HS ${d.harmonizedCode} → ${d.harmonizedCodeNew}]`
          : `[HS ${d.harmonizedCode || ''}]`;
        lines.push(`#${d.index + 1} ${hsLabel}  "${d.from}"  ->  "${d.to}"`);
      });
    }
    diffBox.textContent = lines.join('\\n');
  }
})();
