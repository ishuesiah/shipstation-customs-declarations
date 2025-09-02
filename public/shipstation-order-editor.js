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
    const itemsList = (c.items || []).map(i => `${i.name} (qty: ${i.quantity})`).join('<br>');
    
    tr.innerHTML = `
      <td style="padding:.5rem;"><input type="checkbox" class="bulk-row" data-id="${c.orderId}"></td>
      <td style="padding:.5rem;">#${c.orderNumber || c.orderId}</td>
      <td style="padding:.5rem;">${(c.shipTo?.city || '')}, ${(c.shipTo?.state || '')}</td>
      <td style="padding:.5rem;">${c.changes}</td>
      <td style="padding:.5rem; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85rem;">
        <div style="margin-bottom:0.5rem; color:#666;">Items: ${itemsList}</div>
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
let scanResults = []; // Store results for CSV download

// In shipstation-order-editor.js, update the bulk preview handler
btnBulkPreview?.addEventListener('click', async () => {
  btnBulkApply.disabled = true;
  if (bulkSelectAll) bulkSelectAll.checked = false;
  bulkTbody.innerHTML = '';
  scanResults = [];
  
  const days = Number(bulkDaysEl?.value || 30);
  const pageSize = Number(bulkPageSizeEl?.value || 200);
  const maxPages = Number(bulkMaxPagesEl?.value || 2);
  
  const estimatedTime = maxPages * pageSize * 0.05;
  const warning = estimatedTime > 30 ? ` (Est. ${Math.round(estimatedTime)} seconds)` : '';
  
  // Show timer and log
  document.getElementById('bulkTimer').style.display = 'block';
  document.getElementById('scanLog').style.display = 'block';
  document.getElementById('scanLogContent').innerHTML = 'Starting scan...';
  document.getElementById('bulkActions').style.display = 'none';
  
  let startTime = Date.now();
  let timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    document.getElementById('scanTime').textContent = elapsed;
  }, 1000);
  
  try {
    const qs = new URLSearchParams({
      days: String(days),
      pageSize: String(pageSize),
      maxPages: String(maxPages)
    }).toString();
    
    showBulk(`Scanning ${days} days of orders${warning}...`, 'ok');
    
    const data = await fetchJSON(`/api/shipstation/orders/scan?${qs}`);
    if (!data._ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${data._status}`);
    
    clearInterval(timerInterval);
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    document.getElementById('scanTime').textContent = totalTime;
    document.getElementById('foundCount').textContent = data.totalCandidates || 0;
    document.getElementById('totalScanned').textContent = data.totalScanned || 0;
    
    // Show the scan log
    if (data.scanLog && data.scanLog.length > 0) {
      document.getElementById('scanLogContent').innerHTML = data.scanLog.join('<br>');
    }
    
    scanResults = data.candidates || [];
    
    renderBulkTable(scanResults);
    showBulk(`Scan complete! Found ${data.totalCandidates} orders needing updates. (${data.usOrders || 0} US, ${data.nonUsOrders || 0} non-US)`, 'ok');
    
    if (scanResults.length > 0) {
      document.getElementById('bulkActions').style.display = 'block';
    }
    
  } catch (e) {
    clearInterval(timerInterval);
    showBulk(e.message || 'Scan failed', 'err');
    document.getElementById('scanLogContent').innerHTML += '<br>ERROR: ' + e.message;
  }
});

// Add CSV download handler
// In shipstation-order-editor.js, update the CSV download handler
document.getElementById('btnDownloadScanCSV')?.addEventListener('click', () => {
  if (!scanResults.length) return;
  
  // Build CSV with item details
  const headers = [
    'Order ID', 'Order Number', 'Ship To City', 'Ship To State', 
    'Product Items', 'Product SKUs',
    'Current Customs Description', 'New Customs Description', 
    'Current HS', 'New HS', 'Changes'
  ];
  const rows = [headers];
  
  scanResults.forEach(order => {
    // Get product items for this order
    const itemNames = (order.items || []).map(i => `${i.name} (qty: ${i.quantity})`).join('; ');
    const itemSkus = (order.items || []).map(i => i.sku || 'no-sku').join('; ');
    
    (order.diff || []).forEach(change => {
      rows.push([
        order.orderId,
        order.orderNumber || '',
        order.shipTo?.city || '',
        order.shipTo?.state || '',
        itemNames,  // What's actually in the order
        itemSkus,
        change.from || '',  // Current customs description
        change.to || '',    // New customs description
        change.harmonizedCode || '',
        change.harmonizedCodeNew || '',
        order.changes
      ]);
    });
  });
  
  // Convert to CSV
  const csv = rows.map(row => 
    row.map(cell => {
      const str = String(cell || '');
      return str.includes(',') || str.includes('"') || str.includes('\n') || str.includes(';')
        ? `"${str.replace(/"/g, '""')}"` 
        : str;
    }).join(',')
  ).join('\n');
  
  // Download
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shipstation_scan_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showBulk('CSV downloaded!', 'ok');
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

// Add this to your existing JavaScript file
document.getElementById('btnTestExport')?.addEventListener('click', async () => {
  const orderId = document.getElementById('testOrderId').value.trim();
  if (!orderId) {
    showTestStatus('Please enter an order ID or number', 'err');
    return;
  }
  
  // Build the URL for single order export
  const qs = new URLSearchParams({
    orderId: orderId,
    test: 'true'
  }).toString();
  
  // Direct download
  window.location.href = `/api/shipstation/orders/export-single.csv?${qs}`;
  showTestStatus('Downloading CSV for order ' + orderId, 'ok');
});

// Helper function for test export status
function showTestStatus(msg, kind='ok') {
  const el = document.getElementById('testExportStatus');
  if (el) {
    el.textContent = msg;
    el.className = `status show ${kind === 'ok' ? 'ok' : 'err'}`;
  }
}
// Add this event handler for the 50 orders export button
document.getElementById('btnExport50')?.addEventListener('click', () => {
  const days = document.getElementById('bulkExportDays').value || 30;
  
  const qs = new URLSearchParams({
    days: String(days),
    limit: '50'
  }).toString();
  
  // Show status
  const statusEl = document.getElementById('bulkExportStatus');
  if (statusEl) {
    statusEl.textContent = 'Generating CSV for 50 US orders... This may take a moment.';
    statusEl.className = 'status show ok';
  }
  
  // Direct download
  window.location.href = `/api/shipstation/orders/export-bulk.csv?${qs}`;
  
  setTimeout(() => {
    if (statusEl) {
      statusEl.textContent = 'CSV download started!';
    }
  }, 2000);
});
// Add handler for ALL orders export
// Replace the export ALL handler with this version that includes a live timer:
document.getElementById('btnExportAllOrders')?.addEventListener('click', () => {
  const days = document.getElementById('allExportDays').value || 30;
  const maxOrders = document.getElementById('allExportMax').value || 2000;
  
  const qs = new URLSearchParams({
    days: String(days),
    limit: String(maxOrders),
    all: 'true'
  }).toString();
  
  // UI elements
  const statusEl = document.getElementById('allExportStatus');
  const btn = document.getElementById('btnExportAll');
  
  // Estimate based on 40 API calls per minute
  const estimatedMinutes = Math.round(maxOrders * 1.5 / 60);
  const estimatedSeconds = estimatedMinutes * 60;
  
  // Start timer
  const startTime = Date.now();
  let timerInterval;
  
  // Timer update function
  const updateTimer = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    
    // Calculate estimated remaining
    const progress = Math.min(elapsed / estimatedSeconds, 1);
    const remainingSeconds = Math.max(0, estimatedSeconds - elapsed);
    const remainingMin = Math.floor(remainingSeconds / 60);
    const remainingSec = remainingSeconds % 60;
    
    // Update status display
    if (statusEl) {
      let statusHTML = `
        <div style="font-weight: 600; margin-bottom: 8px;">
          ⏱️ Exporting ALL US Orders...
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 0.9em;">
          <div>
            <strong>Elapsed:</strong> ${minutes}:${seconds.toString().padStart(2, '0')}
          </div>
          <div>
            <strong>Est. Remaining:</strong> ${remainingMin}:${remainingSec.toString().padStart(2, '0')}
          </div>
        </div>
        <div style="margin-top: 8px;">
          <div style="background: #e5e7eb; border-radius: 4px; height: 8px; overflow: hidden;">
            <div style="background: linear-gradient(90deg, #667eea, #764ba2); height: 100%; width: ${Math.round(progress * 100)}%; transition: width 1s;"></div>
          </div>
        </div>
        <div style="margin-top: 6px; font-size: 0.85em; color: #6b7280;">
          Processing ~${Math.round(progress * maxOrders)} of ${maxOrders} orders (estimate)
        </div>
      `;
      statusEl.innerHTML = statusHTML;
      statusEl.className = 'status show ok';
    }
    
    // Stop timer after reasonable max time (2 hours)
    if (elapsed > 7200) {
      clearInterval(timerInterval);
      if (statusEl) {
        statusEl.innerHTML = 'Export is taking longer than expected. Check browser downloads or console for status.';
        statusEl.className = 'status show err';
      }
    }
  };
  
  // Start the timer
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer(); // Initial call
  
  // Disable button
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '📥 Export ALL US Orders (40+ min)';  // Update this text to match
  }
  
  // Start download
  const downloadUrl = `/api/shipstation/orders/export-all.csv?${qs}`;
  
  // Create hidden iframe for download (allows page to stay responsive)
  window.location.href = downloadUrl;

  
  // Clean up after estimated time + buffer
  setTimeout(() => {
    clearInterval(timerInterval);
    
    if (statusEl) {
      statusEl.innerHTML = `
        <div style="font-weight: 600;">✅ Export Complete!</div>
        <div style="margin-top: 4px; font-size: 0.9em;">Check your downloads folder for the CSV file.</div>
      `;
      statusEl.className = 'status show ok';
    }
    
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '📥 Export ALL US Orders (40+ min)';
    }
    
    // Remove iframe
    if (iframe && iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  }, (estimatedSeconds + 60) * 1000); // Add 1 min buffer
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
    diffBox.textContent = lines.join('\n'); 
  }
  
})();
