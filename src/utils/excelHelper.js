import * as XLSX from 'xlsx';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import ImportBatch from '../models/ImportBatch.js';
import User from '../models/User.js';

/**
 * Standard system lead fields for mapping
 */
export const SYSTEM_FIELDS = [
  { key: 'name', label: 'Full Name', required: true, aliases: ['name', 'full name', 'client name', 'customer name', 'lead name'] },
  { key: 'phone', label: 'Phone Number', required: true, aliases: ['phone', 'mobile', 'contact', 'telephone', 'phone number', 'mobile number'] },
  { key: 'whatsapp', label: 'WhatsApp Number', required: false, aliases: ['whatsapp', 'wa', 'whatsapp number', 'wa number'] },
  { key: 'email', label: 'Email Address', required: false, aliases: ['email', 'mail', 'e-mail', 'email address'] },
  { key: 'company', label: 'Company Name', required: false, aliases: ['company', 'organization', 'org', 'firm', 'business', 'company name'] },
  { key: 'city', label: 'City / Location', required: false, aliases: ['city', 'location', 'town', 'address', 'state'] },
  { key: 'product_interest', label: 'Product Interest', required: false, aliases: ['product', 'interest', 'product interest', 'requirement', 'service', 'items'] },
  { key: 'campaign_name', label: 'Ad Campaign', required: false, aliases: ['campaign', 'campaign name', 'campaign_name', 'ad campaign', 'ad name', 'ad_name', 'adset name', 'adset_name', 'meta campaign', 'utm_campaign'] },
  { key: 'source', label: 'Lead Source', required: false, aliases: ['source', 'lead source', 'channel', 'medium'] },
  { key: 'remarks', label: 'Notes / Remarks', required: false, aliases: ['remarks', 'notes', 'comment', 'description', 'note'] }
];

/**
 * Normalize phone numbers
 */
export function normalizePhone(phone) {
  if (!phone) return '';
  const str = String(phone).trim();
  const digits = str.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '+91' + digits.substring(1);
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (str.startsWith('+')) return '+' + digits;
  return digits;
}

export function getPhoneLookupKeys(phone) {
  if (!phone) return [];
  const norm = normalizePhone(phone);
  const digits = String(phone).replace(/\D/g, '');
  const keys = new Set();
  if (norm) keys.add(norm);
  if (digits) keys.add(digits);
  if (digits.length >= 10) keys.add(digits.slice(-10));
  return Array.from(keys);
}

export function generateSampleTemplateBuffer() {
  const sampleData = [
    { 'Full Name': 'Aarav Mehta', 'Phone Number': '+919876543201', 'WhatsApp Number': '+919876543201', 'Email': 'aarav@example.com', 'Company Name': 'Mehta Infotech', 'City': 'Mumbai', 'Product Interest': 'Smart NFC Business Cards (100 units)', 'Ad Campaign': 'Meta Ads - Corporate NFC', 'Lead Source': 'Meta Ads', 'Remarks': 'Interested in matte black metal finish' },
    { 'Full Name': 'Deepika Rao', 'Phone Number': '+919876543202', 'WhatsApp Number': '+919876543202', 'Email': 'deepika@raoenterprises.com', 'Company Name': 'Rao Enterprises', 'City': 'Bengaluru', 'Product Interest': 'Google Review NFC Stands', 'Ad Campaign': 'Meta Ads - Review Stands', 'Lead Source': 'Instagram Campaign', 'Remarks': 'Needs 10 stands for retail stores' },
  ];
  const ws = XLSX.utils.json_to_sheet(sampleData);
  ws['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 28 }, { wch: 24 }, { wch: 16 }, { wch: 35 }, { wch: 26 }, { wch: 18 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sample Leads Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function parseExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('Excel workbook contains no sheets.');
  const worksheet = workbook.Sheets[firstSheetName];
  const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  if (!rawData || rawData.length === 0) {
    return { headers: [], preview: [], totalRows: 0, rows: [], suggestedMapping: {} };
  }

  const headerSet = new Set();
  rawData.forEach(row => {
    Object.keys(row).forEach(k => {
      const cleanKey = k.trim();
      if (cleanKey && !cleanKey.startsWith('__EMPTY')) headerSet.add(k);
    });
  });
  const headers = Array.from(headerSet);

  const suggestedMapping = {};
  for (const sysField of SYSTEM_FIELDS) {
    for (const h of headers) {
      const lower = h.trim().toLowerCase();
      if (sysField.aliases.includes(lower) || lower === sysField.key.toLowerCase()) {
        suggestedMapping[sysField.key] = h;
        break;
      }
    }
  }

  if (!suggestedMapping.name && headers.length > 0) suggestedMapping.name = headers[0];
  if (!suggestedMapping.phone && headers.length > 1) suggestedMapping.phone = headers[1];

  return { headers, preview: rawData.slice(0, 10), totalRows: rawData.length, rows: rawData, suggestedMapping };
}

/**
 * Import rows into MongoDB
 */
export async function processLeadsImport({
  rows,
  columnMapping,
  defaultAssignedTo = null,
  defaultCampaignName = 'Meta Ads - General',
  fileName = 'Excel Import',
  userId,
  userName = 'Admin'
}) {
  if (!rows || rows.length === 0) throw new Error('No rows provided for import.');

  // Fetch all existing phones for duplicate detection
  const existingLeads = await Lead.find({}, { phone: 1, name: 1, status: 1, company: 1 });
  const existingPhoneMap = new Map();
  existingLeads.forEach(l => {
    getPhoneLookupKeys(l.phone).forEach(k => {
      if (!existingPhoneMap.has(k)) existingPhoneMap.set(k, l);
    });
  });

  let assignedUser = null;
  if (defaultAssignedTo) {
    assignedUser = await User.findOne({ _id: defaultAssignedTo, is_active: true });
  }

  const seenInBatchPhones = new Set();
  const summary = {
    total: rows.length,
    importedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    duplicates: [],
    errors: [],
    imported: []
  };

  const validToInsert = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const rawName = columnMapping.name ? row[columnMapping.name] : '';
    const rawPhone = columnMapping.phone ? row[columnMapping.phone] : '';
    const rawWhatsApp = columnMapping.whatsapp ? row[columnMapping.whatsapp] : '';
    const rawEmail = columnMapping.email ? row[columnMapping.email] : '';
    const rawCompany = columnMapping.company ? row[columnMapping.company] : '';
    const rawCity = columnMapping.city ? row[columnMapping.city] : '';
    const rawProduct = columnMapping.product_interest ? row[columnMapping.product_interest] : '';
    const rawCampaign = columnMapping.campaign_name ? row[columnMapping.campaign_name] : '';
    const rawSource = columnMapping.source ? row[columnMapping.source] : '';
    const rawRemarks = columnMapping.remarks ? row[columnMapping.remarks] : '';

    const phone = normalizePhone(rawPhone);
    const name = String(rawName || '').trim() || 'Lead ' + (phone || rowNum);
    const company = String(rawCompany || '').trim() || '';
    const city = String(rawCity || '').trim() || '';
    const productInterest = String(rawProduct || '').trim() || '';
    const campaignName = String(rawCampaign || '').trim() || (defaultCampaignName ? String(defaultCampaignName).trim() : 'Meta Ads - General');

    if (!phone || phone.length < 5) {
      summary.errorCount++;
      summary.errors.push({ row: rowNum, lead_name: name, phone: rawPhone ? String(rawPhone).trim() : '(Empty)', company, city, campaign_name: campaignName, issue_type: 'validation_error', reason: !rawPhone ? 'Missing phone number' : 'Invalid phone number format' });
      continue;
    }

    const lookupKeys = getPhoneLookupKeys(phone);

    let matchedExisting = null;
    for (const key of lookupKeys) {
      if (existingPhoneMap.has(key)) { matchedExisting = existingPhoneMap.get(key); break; }
    }
    if (matchedExisting) {
      summary.duplicateCount++;
      summary.duplicates.push({ row: rowNum, lead_name: name, phone, company, city, campaign_name: campaignName, issue_type: 'duplicate', reason: `Already in CRM as "${matchedExisting.name}" (${matchedExisting.status || 'Active'})` });
      continue;
    }

    let isDuplicateInBatch = false;
    for (const key of lookupKeys) {
      if (seenInBatchPhones.has(key)) { isDuplicateInBatch = true; break; }
    }
    if (isDuplicateInBatch) {
      summary.duplicateCount++;
      summary.duplicates.push({ row: rowNum, lead_name: name, phone, company, city, campaign_name: campaignName, issue_type: 'duplicate', reason: 'Duplicate phone number repeated inside this Excel file' });
      continue;
    }

    lookupKeys.forEach(k => seenInBatchPhones.add(k));
    validToInsert.push({
      name,
      phone,
      whatsapp: normalizePhone(rawWhatsApp) || phone,
      email: String(rawEmail || '').trim() || '',
      company,
      city,
      productInterest,
      campaignName,
      source: String(rawSource || '').trim() || 'Excel Upload',
      remarks: String(rawRemarks || '').trim() || '',
      rowNum
    });
  }

  // Bulk insert valid leads
  for (const item of validToInsert) {
    try {
      const lead = await Lead.create({
        name: item.name,
        phone: item.phone,
        whatsapp: item.whatsapp,
        email: item.email,
        company: item.company,
        city: item.city,
        product_interest: item.productInterest,
        campaign_name: item.campaignName,
        source: item.source,
        assigned_to: assignedUser ? [assignedUser._id] : [],
        status: 'New',
        remarks: item.remarks
      });

      await LeadActivity.create({
        lead_id: lead._id,
        user_id: userId || null,
        user_name: userName,
        old_status: null,
        new_status: 'New',
        notes: assignedUser ? `Lead imported via Excel and assigned to ${assignedUser.name}` : 'Lead imported via Excel (Unassigned)'
      });

      summary.importedCount++;
      summary.imported.push({ id: lead._id.toString(), name: item.name, phone: item.phone, company: item.company, campaign_name: item.campaignName });
    } catch (err) {
      if (err.code === 11000) {
        summary.duplicateCount++;
        summary.duplicates.push({ row: item.rowNum, lead_name: item.name, phone: item.phone, company: item.company, city: item.city, campaign_name: item.campaignName, issue_type: 'duplicate', reason: 'Duplicate phone detected on insert' });
      } else {
        summary.errorCount++;
        summary.errors.push({ row: item.rowNum, lead_name: item.name, phone: item.phone, company: item.company, city: item.city, campaign_name: item.campaignName, issue_type: 'validation_error', reason: err.message });
      }
    }
  }

  // Save import batch
  try {
    const batch = await ImportBatch.create({
      file_name: fileName,
      total_rows: rows.length,
      imported_count: summary.importedCount,
      duplicate_count: summary.duplicateCount,
      error_count: summary.errorCount,
      imported_by: userId || null,
      imported_by_name: userName || 'Admin',
      issues: [...summary.errors, ...summary.duplicates]
    });
    summary.batchId = batch._id.toString();
  } catch (err) {
    console.error('Failed to log import batch:', err);
  }

  return summary;
}

export function generateErrorReportBuffer(errors, duplicates) {
  const reportRows = [
    ...errors.map(e => ({ 'Type': 'Validation Error', 'Row Number': e.row, 'Name': e.name || e.lead_name, 'Phone': e.phone, 'Company': e.company || '—', 'City': e.city || '—', 'Ad Campaign': e.campaign_name || '—', 'Reason': e.reason })),
    ...duplicates.map(d => ({ 'Type': 'Duplicate Skipped', 'Row Number': d.row, 'Name': d.name || d.lead_name, 'Phone': d.phone, 'Company': d.company || '—', 'City': d.city || '—', 'Ad Campaign': d.campaign_name || '—', 'Reason': d.reason }))
  ];
  const ws = XLSX.utils.json_to_sheet(reportRows);
  ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 20 }, { wch: 16 }, { wch: 24 }, { wch: 45 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import Issues Report');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Generate salesperson-wise leads report:
 *   - Sheet 1: "Summary" with one row per salesperson + stats
 *   - One sheet per salesperson with their full lead list
 */
export function generateSalespersonReportBuffer(groupedData, reportDate) {
  const wb = XLSX.utils.book_new();
  const dateLabel = reportDate || new Date().toLocaleDateString('en-IN');

  // ── 1. Summary Sheet ─────────────────────────────────────────────────────
  const summaryRows = groupedData.map(g => ({
    'Salesperson': g.name,
    'Total Leads': g.leads.length,
    'New': g.leads.filter(l => l.status === 'New').length,
    'Contacted': g.leads.filter(l => l.status === 'Contacted').length,
    'Interested': g.leads.filter(l => l.status === 'Interested').length,
    'Follow-up': g.leads.filter(l => l.status === 'Follow-up').length,
    'Quotation Sent': g.leads.filter(l => l.status === 'Quotation Sent').length,
    'Won': g.leads.filter(l => l.status === 'Won').length,
    'Lost': g.leads.filter(l => l.status === 'Lost').length,
    'Not Reachable': g.leads.filter(l => l.status === 'Not Reachable').length,
    'Conversion Rate': g.leads.length > 0
      ? `${((g.leads.filter(l => l.status === 'Won').length / g.leads.length) * 100).toFixed(1)}%`
      : '0%',
    'Report Date': dateLabel
  }));

  // Add totals row
  const allLeads = groupedData.flatMap(g => g.leads);
  summaryRows.push({
    'Salesperson': '── TOTAL ──',
    'Total Leads': allLeads.length,
    'New': allLeads.filter(l => l.status === 'New').length,
    'Contacted': allLeads.filter(l => l.status === 'Contacted').length,
    'Interested': allLeads.filter(l => l.status === 'Interested').length,
    'Follow-up': allLeads.filter(l => l.status === 'Follow-up').length,
    'Quotation Sent': allLeads.filter(l => l.status === 'Quotation Sent').length,
    'Won': allLeads.filter(l => l.status === 'Won').length,
    'Lost': allLeads.filter(l => l.status === 'Lost').length,
    'Not Reachable': allLeads.filter(l => l.status === 'Not Reachable').length,
    'Conversion Rate': allLeads.length > 0
      ? `${((allLeads.filter(l => l.status === 'Won').length / allLeads.length) * 100).toFixed(1)}%`
      : '0%',
    'Report Date': dateLabel
  });

  const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
  summaryWs['!cols'] = [
    { wch: 24 }, { wch: 13 }, { wch: 9 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 16 }, { wch: 9 }, { wch: 9 }, { wch: 14 },
    { wch: 17 }, { wch: 16 }
  ];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

  // ── 2. One sheet per salesperson ─────────────────────────────────────────
  for (const group of groupedData) {
    const sheetName = (group.name || 'Unassigned').substring(0, 31).replace(/[:\\/?*[\]]/g, '');

    const rows = group.leads.map((l, idx) => ({
      '#': idx + 1,
      'Customer Name': l.name,
      'Phone Number': l.phone,
      'Last Status': l.status,
      'Next Follow-up Date': l.follow_up_date || '',
      'Remarks': l.remarks || ''
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 5 },
      { wch: 28 },
      { wch: 18 },
      { wch: 20 },
      { wch: 20 },
      { wch: 45 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function exportLeadsToExcelBuffer(leads) {
  const exportData = leads.map(l => ({
    'ID': l._id ? l._id.toString() : l.id,
    'Name': l.name,
    'Phone': l.phone,
    'WhatsApp': l.whatsapp || l.phone,
    'Email': l.email || '',
    'Company': l.company || '',
    'City': l.city || '',
    'Product Interest': l.product_interest || '',
    'Ad Campaign': l.campaign_name || 'Meta Ads - General',
    'Source': l.source || '',
    'Status': l.status,
    'Assigned To': l.assigned_user_name || 'Unassigned',
    'Follow-up Date': l.follow_up_date || '',
    'Remarks': l.remarks || '',
    'Created At': l.createdAt ? new Date(l.createdAt).toLocaleString() : ''
  }));
  const ws = XLSX.utils.json_to_sheet(exportData);
  ws['!cols'] = [{ wch: 26 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 32 }, { wch: 28 }, { wch: 16 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 45 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads Export');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
