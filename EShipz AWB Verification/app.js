(function () {
  // State
  let metabaseFiles = [];
  let eshipzFiles = [];
  let resultData = { common: [], onlyMetabase: [], onlyEshipz: [] };
  let worker = null;

  // DOM refs
  const metabaseZone = document.getElementById('metabaseZone');
  const metabaseInput = document.getElementById('metabaseInput');
  const metabaseFileList = document.getElementById('metabaseFileList');
  const eshipzZone = document.getElementById('eshipzZone');
  const eshipzInput = document.getElementById('eshipzInput');
  const eshipzFileList = document.getElementById('eshipzFileList');
  const compareBtn = document.getElementById('compareBtn');
  const resetBtn = document.getElementById('resetBtn');
  const statusArea = document.getElementById('statusArea');
  const resultsSection = document.getElementById('resultsSection');

  // --- Create Web Worker ---
  function createWorker() {
    return new Worker('worker.js');
  }

  // --- Upload zone wiring ---
  function wireUploadZone(zone, input, addFilesFn) {
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { addFilesFn(Array.from(input.files)); input.value = ''; });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      addFilesFn(Array.from(e.dataTransfer.files));
    });
  }

  function addMetabaseFiles(files) {
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (csvFiles.length < files.length) showStatus('Some non-CSV files were skipped.', 'error');
    metabaseFiles.push(...csvFiles);
    renderFileList(metabaseFileList, metabaseFiles, removeMetabaseFile);
    updateCompareBtn();
  }

  function addEshipzFiles(files) {
    const xlFiles = files.filter(f => /\.(xlsx|xls)$/i.test(f.name));
    if (xlFiles.length < files.length) showStatus('Some non-Excel files were skipped.', 'error');
    eshipzFiles.push(...xlFiles);
    renderFileList(eshipzFileList, eshipzFiles, removeEshipzFile);
    updateCompareBtn();
  }

  function removeMetabaseFile(f) {
    metabaseFiles = metabaseFiles.filter(x => x !== f);
    renderFileList(metabaseFileList, metabaseFiles, removeMetabaseFile);
    updateCompareBtn();
  }

  function removeEshipzFile(f) {
    eshipzFiles = eshipzFiles.filter(x => x !== f);
    renderFileList(eshipzFileList, eshipzFiles, removeEshipzFile);
    updateCompareBtn();
  }

  wireUploadZone(metabaseZone, metabaseInput, addMetabaseFiles);
  wireUploadZone(eshipzZone, eshipzInput, addEshipzFiles);

  // --- File list rendering ---
  function renderFileList(container, files, removeFn) {
    container.innerHTML = '';
    files.forEach((f) => {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `
        <span class="name">${escapeHtml(f.name)}</span>
        <span class="size">${formatSize(f.size)}</span>
        <span class="remove" title="Remove">&times;</span>
      `;
      div.querySelector('.remove').addEventListener('click', () => removeFn(f));
      container.appendChild(div);
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function updateCompareBtn() {
    compareBtn.disabled = !(metabaseFiles.length > 0 && eshipzFiles.length > 0);
  }

  // --- Status display ---
  function showStatus(msg, type) {
    statusArea.innerHTML = `<div class="status ${type}">${msg}</div>`;
  }

  function showProgress(msg, percent) {
    statusArea.innerHTML = `
      <div class="status processing">
        ${escapeHtml(msg)}
        <div class="progress-bar"><div class="fill" style="width:${percent}%"></div></div>
      </div>`;
  }

  function clearStatus() { statusArea.innerHTML = ''; }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Comparison (via Web Worker) ---
  compareBtn.addEventListener('click', function() {
    clearStatus();
    resultsSection.classList.remove('visible');
    showProgress('Starting comparison...', 0);
    compareBtn.disabled = true;
    resetBtn.disabled = true;

    // Create worker and send File objects directly
    // This is memory efficient because File objects are clones of the original file reference
    if (worker) worker.terminate();
    worker = createWorker();

    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'progress') {
        showProgress(msg.message, msg.percent);
      } else if (msg.type === 'result') {
        displayResults(msg);
        worker.terminate();
        worker = null;
        resetBtn.disabled = false;
        updateCompareBtn();
      }
    };

    worker.onerror = function(err) {
      showStatus('Worker error: ' + err.message, 'error');
      resetBtn.disabled = false;
      updateCompareBtn();
    };

    worker.postMessage({
      type: 'processAll',
      files: { metabase: metabaseFiles, eshipz: eshipzFiles }
    });
  });

  // --- Display results ---
  function displayResults(msg) {
    resultData = { common: msg.common, onlyMetabase: msg.onlyMetabase, onlyEshipz: msg.onlyEshipz };

    document.getElementById('statMetabase').textContent = msg.metabaseCount.toLocaleString();
    document.getElementById('statEshipz').textContent = msg.eshipzCount.toLocaleString();
    document.getElementById('statCommon').textContent = msg.common.length.toLocaleString();
    document.getElementById('statOnlyMetabase').textContent = msg.onlyMetabase.length.toLocaleString();
    document.getElementById('statOnlyEshipz').textContent = msg.onlyEshipz.length.toLocaleString();

    document.getElementById('badgeCommon').textContent = msg.common.length.toLocaleString();
    document.getElementById('badgeOnlyMetabase').textContent = msg.onlyMetabase.length.toLocaleString();
    document.getElementById('badgeOnlyEshipz').textContent = msg.onlyEshipz.length.toLocaleString();

    populateTable('commonTable', msg.common);
    populateTable('onlyMetabaseTable', msg.onlyMetabase);
    populateTable('onlyEshipzTable', msg.onlyEshipz);

    resultsSection.classList.add('visible');

    let statusMsg = `Done! Found <strong>${msg.common.length.toLocaleString()}</strong> common AWBs out of <strong>${msg.metabaseCount.toLocaleString()}</strong> Metabase and <strong>${msg.eshipzCount.toLocaleString()}</strong> EShipz unique AWBs.`;
    if (msg.errors.length) statusMsg += '<br><br><strong>Warnings:</strong><br>' + msg.errors.map(escapeHtml).join('<br>');
    showStatus(statusMsg, 'success');
  }

  function populateTable(tableId, awbs) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    const limit = 500;
    const display = awbs.slice(0, limit);
    let html = '';
    for (let i = 0; i < display.length; i++) {
      html += `<tr><td>${i + 1}</td><td>${escapeHtml(display[i])}</td></tr>`;
    }
    if (awbs.length > limit) {
      html += `<tr><td colspan="2" style="text-align:center;color:#94a3b8;font-style:italic;">Showing ${limit} of ${awbs.length.toLocaleString()} — download for full list</td></tr>`;
    }
    if (awbs.length === 0) {
      html = '<tr><td colspan="2" style="text-align:center;color:#94a3b8;font-style:italic;">No AWBs in this category</td></tr>';
    }
    tbody.innerHTML = html;
  }

  // --- Tabs ---
  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // --- Downloads (streamed via Blob to handle large lists) ---
  function downloadCSV(filename, awbs) {
    const chunkSize = 100000;
    const parts = ['AWB\n'];
    for (let i = 0; i < awbs.length; i += chunkSize) {
      parts.push(awbs.slice(i, i + chunkSize).join('\n'));
      if (i + chunkSize < awbs.length) parts.push('\n');
    }
    const blob = new Blob(parts, { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
  }

  document.getElementById('downloadCommon').addEventListener('click', () => downloadCSV('common_awbs.csv', resultData.common));
  document.getElementById('downloadOnlyMetabase').addEventListener('click', () => downloadCSV('only_in_metabase.csv', resultData.onlyMetabase));
  document.getElementById('downloadOnlyEshipz').addEventListener('click', () => downloadCSV('only_in_eshipz.csv', resultData.onlyEshipz));

  // --- Reset ---
  resetBtn.addEventListener('click', function() {
    if (worker) { worker.terminate(); worker = null; }
    metabaseFiles = [];
    eshipzFiles = [];
    resultData = { common: [], onlyMetabase: [], onlyEshipz: [] };
    metabaseFileList.innerHTML = '';
    eshipzFileList.innerHTML = '';
    resultsSection.classList.remove('visible');
    clearStatus();
    updateCompareBtn();
    resetBtn.disabled = false;
  });
})();
