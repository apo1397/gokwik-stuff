importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

// --- AWB column detection ---
const AWB_PATTERNS = [
  /^awb$/i, /^awb[_ ]?no$/i, /^awb[_ ]?number$/i, /^awb[_ ]?num$/i,
  /^airway[_ ]?bill$/i, /^airway[_ ]?bill[_ ]?no$/i, /^airway[_ ]?bill[_ ]?number$/i,
  /^tracking[_ ]?number$/i, /^tracking[_ ]?no$/i, /^tracking[_ ]?id$/i,
  /^waybill$/i, /^waybill[_ ]?number$/i,
  /awb/i
];

function findAwbColumn(headers) {
  for (const pattern of AWB_PATTERNS) {
    for (const h of headers) {
      if (pattern.test(h.trim())) return h;
    }
  }
  return null;
}

function normalizeAwb(val) {
  if (val == null) return '';
  return String(val).trim().replace(/\.0+$/, '');
}

// --- Streaming CSV parser: extracts only the AWB column index, yields values ---
function extractAwbsFromCSVText(text) {
  const awbs = [];
  // Find the first newline to get the header row
  let headerEnd = text.indexOf('\n');
  if (headerEnd === -1) return { awbs: [], error: 'no data rows' };
  let headerLine = text.substring(0, headerEnd).replace(/\r$/, '');

  // Parse header (handle quoted headers)
  const headers = parseCSVRow(headerLine);
  const awbCol = findAwbColumn(headers);
  if (!awbCol) return { awbs: [], error: 'no AWB column found (columns: ' + headers.join(', ') + ')' };
  const colIdx = headers.indexOf(awbCol);

  // Parse row by row from the rest of the text
  let pos = headerEnd + 1;
  let rowCount = 0;
  while (pos < text.length) {
    // Find end of current row (respecting quotes)
    let rowEnd = findRowEnd(text, pos);
    let rowText = text.substring(pos, rowEnd).replace(/\r$/, '');
    pos = rowEnd + 1;

    if (rowText.length === 0) continue;

    // Fast path: if colIdx is 0 and no quotes, just grab up to first comma
    let val;
    if (colIdx === 0 && rowText[0] !== '"') {
      let commaPos = rowText.indexOf(',');
      val = commaPos === -1 ? rowText : rowText.substring(0, commaPos);
    } else {
      // Need to parse columns up to colIdx
      val = extractColumnFromRow(rowText, colIdx);
    }

    val = normalizeAwb(val);
    if (val) awbs.push(val);
    rowCount++;
  }

  return { awbs, error: null, rowCount };
}

function parseCSVRow(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else { field += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(field); field = ''; }
      else field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function findRowEnd(text, start) {
  let inQuotes = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"') inQuotes = !inQuotes;
    else if (text[i] === '\n' && !inQuotes) return i;
  }
  return text.length;
}

function extractColumnFromRow(rowText, targetIdx) {
  let fieldIdx = 0;
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < rowText.length; i++) {
    const ch = rowText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < rowText.length && rowText[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else { field += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        if (fieldIdx === targetIdx) return field;
        fieldIdx++;
        field = '';
      } else field += ch;
    }
  }
  return fieldIdx === targetIdx ? field : '';
}

// --- Extract AWBs from Excel ArrayBuffer: process one sheet at a time, extract only AWB column ---
function extractAwbsFromExcelBuffer(buffer, fileName) {
  const awbs = [];
  const errors = [];

  // Parse workbook — use dense mode (array of arrays) to reduce memory vs object mode
  const wb = XLSX.read(buffer, { type: 'array', dense: true });
  let foundAny = false;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!data'] || sheet['!data'].length < 2) continue;

    const data = sheet['!data'];
    // Get headers from first row
    const headerRow = data[0];
    if (!headerRow) continue;

    const headers = headerRow.map(cell => cell ? String(cell.v != null ? cell.v : '') : '');
    const awbCol = findAwbColumn(headers);
    if (!awbCol) continue;
    foundAny = true;
    const colIdx = headers.indexOf(awbCol);

    // Extract only AWB column from each data row
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row || !row[colIdx]) continue;
      const cellVal = row[colIdx].v;
      const val = normalizeAwb(cellVal);
      if (val) awbs.push(val);
    }

    // Release sheet data to free memory
    delete wb.Sheets[sheetName];
  }

  if (!foundAny) errors.push(fileName + ': no AWB column found in any sheet');
  return { awbs, errors };
}

// --- Main message handler ---
self.onmessage = async function(e) {
  const { type, files } = e.data;

  if (type === 'processAll') {
    const metabaseAwbSet = new Set();
    const eshipzAwbSet = new Set();
    const allErrors = [];
    const totalFiles = files.metabase.length + files.eshipz.length;
    let processedFiles = 0;

    // Helper to read file as ArrayBuffer in worker
    const readFile = (file) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
        reader.readAsArrayBuffer(file);
      });
    };

    // Process Metabase CSV files one at a time
    for (let i = 0; i < files.metabase.length; i++) {
      const f = files.metabase[i];
      self.postMessage({
        type: 'progress',
        message: 'Processing Metabase CSV: ' + f.name + ' (' + (i + 1) + '/' + files.metabase.length + ')',
        percent: Math.round((processedFiles / totalFiles) * 100)
      });

      try {
        const buffer = await readFile(f);
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(buffer);
        const result = extractAwbsFromCSVText(text);
        if (result.error) {
          allErrors.push(f.name + ': ' + result.error);
        } else {
          for (const awb of result.awbs) metabaseAwbSet.add(awb);
        }
      } catch (err) {
        allErrors.push(f.name + ': ' + err.message);
      }

      processedFiles++;
    }

    // Process EShipz Excel files one at a time
    for (let i = 0; i < files.eshipz.length; i++) {
      const f = files.eshipz[i];
      self.postMessage({
        type: 'progress',
        message: 'Processing EShipz Excel: ' + f.name + ' (' + (i + 1) + '/' + files.eshipz.length + ') — this may take a moment for large files',
        percent: Math.round((processedFiles / totalFiles) * 100)
      });

      try {
        const buffer = await readFile(f);
        const result = extractAwbsFromExcelBuffer(buffer, f.name);
        for (const awb of result.awbs) eshipzAwbSet.add(awb);
        allErrors.push(...result.errors);
      } catch (err) {
        allErrors.push(f.name + ': ' + err.message);
      }

      processedFiles++;
    }

    // Compare
    self.postMessage({ type: 'progress', message: 'Comparing AWB sets...', percent: 90 });

    const common = [];
    const onlyMetabase = [];
    for (const awb of metabaseAwbSet) {
      if (eshipzAwbSet.has(awb)) common.push(awb);
      else onlyMetabase.push(awb);
    }
    const onlyEshipz = [];
    for (const awb of eshipzAwbSet) {
      if (!metabaseAwbSet.has(awb)) onlyEshipz.push(awb);
    }

    common.sort();
    onlyMetabase.sort();
    onlyEshipz.sort();

    self.postMessage({
      type: 'result',
      metabaseCount: metabaseAwbSet.size,
      eshipzCount: eshipzAwbSet.size,
      common,
      onlyMetabase,
      onlyEshipz,
      errors: allErrors
    });
  }
};
