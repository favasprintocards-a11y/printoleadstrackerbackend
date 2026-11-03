import express from 'express';
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import ImportBatch from '../models/ImportBatch.js';
import User from '../models/User.js';
import { authenticate, requireAdmin, requireSalesOrAdmin } from '../middleware/auth.js';
import { uploadExcel } from '../middleware/upload.js';
import {
  generateSampleTemplateBuffer,
  parseExcelBuffer,
  processLeadsImport,
  generateErrorReportBuffer,
  exportLeadsToExcelBuffer,
  generateSalespersonReportBuffer,
  normalizePhone,
  formatISTDate,
  getISTDateString
} from '../utils/excelHelper.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate, requireSalesOrAdmin);

const VALID_STATUSES = [
  'New',
  'Contacted',
  'Interested',
  'Follow-up',
  'Quotation Sent',
  'Won',
  'Lost',
  'Not Reachable'
];

/**
 * Helper to format a Lead Mongoose document for frontend consistency
 */
function formatLead(lead) {
  if (!lead) return null;
  const doc = lead.toObject ? lead.toObject() : lead;
  const assignedUsers = Array.isArray(doc.assigned_to)
    ? doc.assigned_to.map(u => {
      if (u && typeof u === 'object' && u._id) {
        return {
          id: u._id.toString(),
          _id: u._id.toString(),
          name: u.name,
          email: u.email,
          phone: u.phone || ''
        };
      }
      return { id: String(u), _id: String(u) };
    })
    : [];

  const assignedNames = assignedUsers.filter(u => u.name).map(u => u.name).join(', ');
  const assignedIds = assignedUsers.map(u => u.id).join(',');
  const primaryAssignedId = assignedUsers.length > 0 ? assignedUsers[0].id : null;

  return {
    ...doc,
    id: doc._id.toString(),
    _id: doc._id.toString(),
    assigned_to: primaryAssignedId,
    assigned_user_name: assignedNames || 'Unassigned',
    assigned_user_ids: assignedIds,
    assigned_users: assignedUsers,
    assigned_user_email: (assignedUsers[0] && assignedUsers[0].email) || '',
    created_at: doc.createdAt,
    updated_at: doc.updatedAt
  };
}

/**
 * GET /api/leads/template
 * Download sample Excel template for bulk upload (Admin only)
 */
router.get('/template', requireAdmin, (req, res) => {
  try {
    const buffer = generateSampleTemplateBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_upload_template.xlsx"');
    return res.send(buffer);
  } catch (err) {
    console.error('Template download error:', err);
    return res.status(500).json({ error: 'Failed to generate template.' });
  }
});

/**
 * POST /api/leads/upload/preview
 * Upload Excel file to parse headers and preview first 10 rows (Admin only)
 */
router.post('/upload/preview', requireAdmin, uploadExcel.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an Excel or CSV file.' });
    }

    const parsed = parseExcelBuffer(req.file.buffer);
    return res.json(parsed);
  } catch (err) {
    console.error('Excel preview error:', err);
    return res.status(400).json({ error: err.message || 'Failed to parse Excel file.' });
  }
});

/**
 * POST /api/leads/upload/import
 * Execute the import with provided column mapping and optional assignment (Admin only)
 */
router.post('/upload/import', requireAdmin, async (req, res) => {
  try {
    const { rows, columnMapping, defaultAssignedTo, defaultCampaignName, fileName } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided for import.' });
    }

    if (!columnMapping || !columnMapping.phone) {
      return res.status(400).json({ error: 'Column mapping for Phone Number is required.' });
    }

    const summary = await processLeadsImport({
      rows,
      columnMapping,
      defaultAssignedTo: defaultAssignedTo || null,
      defaultCampaignName: defaultCampaignName || 'Meta Ads - General',
      fileName: fileName || 'Excel Import',
      userId: req.user._id,
      userName: req.user.name
    });

    return res.json({
      message: 'Import processing completed.',
      summary
    });
  } catch (err) {
    console.error('Excel import error:', err);
    return res.status(500).json({ error: err.message || 'Failed to import leads.' });
  }
});

/**
 * GET /api/leads/upload/history
 * List past import batches (Admin only)
 */
router.get('/upload/history', requireAdmin, async (req, res) => {
  try {
    const batches = await ImportBatch.find().sort({ createdAt: -1 }).limit(25);
    const formatted = batches.map(b => {
      const issues = Array.isArray(b.issues) ? b.issues : [];
      const actual_duplicate_count = issues.filter(i => i.issue_type === 'duplicate').length;
      const actual_error_count = issues.filter(i => i.issue_type === 'validation_error').length;
      return {
        ...b.toJSON(),
        id: b._id.toString(),
        actual_duplicate_count,
        actual_error_count
      };
    });
    return res.json({ batches: formatted });
  } catch (err) {
    console.error('Fetch import history error:', err);
    return res.status(500).json({ error: 'Failed to retrieve import history.' });
  }
});

/**
 * GET /api/leads/upload/history/:batchId/issues
 * Get duplicate skipped and validation error leads for a specific batch (Admin only)
 */
router.get('/upload/history/:batchId/issues', requireAdmin, async (req, res) => {
  try {
    const { batchId } = req.params;
    let batch = null;
    if (mongoose.Types.ObjectId.isValid(batchId)) {
      batch = await ImportBatch.findById(batchId);
    }
    if (!batch) {
      return res.status(404).json({ error: 'Import batch not found.' });
    }

    const issues = batch.issues || [];
    const duplicates = issues.filter(i => i.issue_type === 'duplicate');
    const errors = issues.filter(i => i.issue_type === 'validation_error');

    return res.json({
      batch: { ...batch.toJSON(), id: batch._id.toString() },
      totalIssues: issues.length,
      duplicateCount: duplicates.length,
      errorCount: errors.length,
      duplicates,
      errors,
      issues
    });
  } catch (err) {
    console.error('Fetch batch issues error:', err);
    return res.status(500).json({ error: 'Failed to retrieve batch issues.' });
  }
});

/**
 * GET /api/leads/upload/issues/latest
 * Get duplicate skipped and validation error leads from the latest import or recent batch (Admin only)
 */
router.get('/upload/issues/latest', requireAdmin, async (req, res) => {
  try {
    const latestBatch = await ImportBatch.findOne().sort({ createdAt: -1 });
    if (!latestBatch) {
      return res.json({
        batch: null,
        totalIssues: 0,
        duplicateCount: 0,
        errorCount: 0,
        duplicates: [],
        errors: [],
        issues: []
      });
    }

    const issues = latestBatch.issues || [];
    const duplicates = issues.filter(i => i.issue_type === 'duplicate');
    const errors = issues.filter(i => i.issue_type === 'validation_error');

    return res.json({
      batch: { ...latestBatch.toJSON(), id: latestBatch._id.toString() },
      totalIssues: issues.length,
      duplicateCount: duplicates.length,
      errorCount: errors.length,
      duplicates,
      errors,
      issues
    });
  } catch (err) {
    console.error('Fetch latest issues error:', err);
    return res.status(500).json({ error: 'Failed to retrieve latest import issues.' });
  }
});

/**
 * POST /api/leads/upload/error-report
 * Download Excel report of skipped duplicates and validation errors
 */
router.post('/upload/error-report', requireAdmin, (req, res) => {
  try {
    const { errors = [], duplicates = [] } = req.body;
    const buffer = generateErrorReportBuffer(errors, duplicates);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="import_issues_report.xlsx"');
    return res.send(buffer);
  } catch (err) {
    console.error('Error report error:', err);
    return res.status(500).json({ error: 'Failed to generate error report.' });
  }
});

/**
 * Helper to fetch and attach the last entered remark for a list of leads from LeadActivity
 */
async function attachLastEnteredRemarks(leads) {
  if (!leads || leads.length === 0) return leads;
  const leadIds = leads.map(l => l._id || l.id).filter(id => mongoose.Types.ObjectId.isValid(id));
  if (leadIds.length === 0) return leads;

  const activities = await LeadActivity.find({ lead_id: { $in: leadIds } })
    .sort({ createdAt: -1 })
    .lean();

  const systemPrefixes = [
    'status updated to',
    'updated lead status to',
    'follow-up date set to',
    'assigned to',
    'lead unassigned',
    'co-assigned to',
    'lead imported',
    'lead created'
  ];

  const remarkMap = new Map();

  for (const act of activities) {
    const lid = act.lead_id.toString();
    const note = (act.notes || '').trim();
    if (!note) continue;

    const lower = note.toLowerCase();
    const isSystem = systemPrefixes.some(p => lower.startsWith(p));

    if (!isSystem && !remarkMap.has(lid)) {
      remarkMap.set(lid, note);
    }
  }

  for (const lead of leads) {
    const lid = (lead._id || lead.id).toString();
    if (remarkMap.has(lid)) {
      lead.remarks = remarkMap.get(lid);
    } else if (lead.remarks && lead.remarks.trim()) {
      lead.remarks = lead.remarks.trim();
    } else {
      lead.remarks = '';
    }
  }

  return leads;
}

/**
 * GET & POST /api/leads/report/salesperson
 * Download salesperson-wise leads report Excel
 * Supports query params or POST body with lead_ids
 */
const generateSalespersonReportHandler = async (req, res) => {
  try {
    const params = req.method === 'POST' ? req.body : req.query;
    const { date_from, date_to, campaign, status } = params;
    const rawIds = params.lead_ids || params.ids;

    const filter = {};
    if (rawIds) {
      const idArray = Array.isArray(rawIds) ? rawIds : String(rawIds).split(',');
      const validIds = idArray.map(s => String(s).trim()).filter(id => mongoose.Types.ObjectId.isValid(id));
      if (validIds.length > 0) {
        filter._id = { $in: validIds };
      }
    }

    if (campaign && campaign !== 'all') filter.campaign_name = campaign;
    if (status && status !== 'all') filter.status = status;
    if (date_from || date_to) {
      filter.createdAt = {};
      if (date_from) filter.createdAt.$gte = new Date(date_from + 'T00:00:00.000Z');
      if (date_to) filter.createdAt.$lte = new Date(date_to + 'T23:59:59.999Z');
    }

    // Role check: sales can only download their own assigned leads
    if (req.user.role === 'sales') {
      filter.assigned_to = req.user._id;
    }

    // Fetch all matching leads with assigned user populated
    const leadsRaw = await Lead.find(filter)
      .populate('assigned_to', 'name email phone')
      .sort({ createdAt: -1 });

    const leads = leadsRaw.map(formatLead);
    await attachLastEnteredRemarks(leads);
    // Fetch all active sales users for grouping
    const salesUsers = await User.find({ role: 'sales', is_active: true }).sort({ name: 1 });

    // Build grouped data: one group per salesperson, plus Unassigned
    const userMap = new Map();

    // Pre-populate with all sales users (even those with 0 leads)
    for (const u of salesUsers) {
      userMap.set(u._id.toString(), {
        userId: u._id.toString(),
        name: u.name,
        email: u.email || '',
        leads: []
      });
    }

    // Bucket Unassigned
    userMap.set('unassigned', {
      userId: 'unassigned',
      name: 'Unassigned',
      email: '',
      leads: []
    });

    // Assign each lead to its salesperson bucket(s)
    for (const lead of leads) {
      const assignedIds = lead.assigned_user_ids
        ? String(lead.assigned_user_ids).split(',').filter(Boolean)
        : [];

      if (assignedIds.length === 0) {
        userMap.get('unassigned').leads.push(lead);
      } else {
        for (const uid of assignedIds) {
          if (userMap.has(uid)) {
            userMap.get(uid).leads.push(lead);
          } else {
            // Edge case: user no longer active — add them dynamically
            const fallbackName = lead.assigned_user_name || uid;
            if (!userMap.has(uid)) {
              userMap.set(uid, { userId: uid, name: fallbackName, email: '', leads: [] });
            }
            userMap.get(uid).leads.push(lead);
          }
        }
      }
    }

    // Sort: users with leads first, then alphabetically; Unassigned always last
    const groupedData = Array.from(userMap.values())
      .filter(g => g.userId !== 'unassigned')
      .sort((a, b) => {
        if (b.leads.length !== a.leads.length) return b.leads.length - a.leads.length;
        return a.name.localeCompare(b.name);
      });

    // Only add Unassigned if it has leads
    const unassignedGroup = userMap.get('unassigned');
    if (unassignedGroup.leads.length > 0) {
      groupedData.push(unassignedGroup);
    }

    const reportDate = formatISTDate(new Date());

    const buffer = generateSalespersonReportBuffer(groupedData, reportDate);

    const isSelected = !!rawIds;
    const fileName = isSelected
      ? `selected_leads_report_${getISTDateString()}.xlsx`
      : `salesperson_leads_report_${getISTDateString()}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Salesperson report error:', err);
    return res.status(500).json({ error: 'Failed to generate salesperson report.' });
  }
};

router.get('/report/salesperson', generateSalespersonReportHandler);
router.post('/report/salesperson', generateSalespersonReportHandler);

/**
 * GET & POST /api/leads/export
 * Export filtered or selected leads to Excel (Admin only)
 */
const exportLeadsHandler = async (req, res) => {
  try {
    const params = req.method === 'POST' ? req.body : req.query;
    const { search, status, assigned_to, city, source, campaign, date_from, date_to, sort_by = 'created_at', sort_order = 'desc' } = params;
    const rawIds = params.lead_ids || params.ids;

    const filter = {};

    if (rawIds) {
      const idArray = Array.isArray(rawIds) ? rawIds : String(rawIds).split(',');
      const validIds = idArray.map(s => String(s).trim()).filter(id => mongoose.Types.ObjectId.isValid(id));
      if (validIds.length > 0) {
        filter._id = { $in: validIds };
      }
    }

    if (search) {
      const s = search.trim();
      filter.$or = [
        { name: { $regex: s, $options: 'i' } },
        { phone: { $regex: s, $options: 'i' } },
        { email: { $regex: s, $options: 'i' } },
        { company: { $regex: s, $options: 'i' } }
      ];
    }

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (assigned_to && assigned_to !== 'all') {
      if (assigned_to === 'unassigned') {
        filter.$or = [{ assigned_to: { $size: 0 } }, { assigned_to: null }, { assigned_to: { $exists: false } }];
      } else if (mongoose.Types.ObjectId.isValid(assigned_to)) {
        filter.assigned_to = assigned_to;
      }
    }

    if (city && city !== 'all') filter.city = city;
    if (source && source !== 'all') filter.source = source;
    if (campaign && campaign !== 'all') filter.campaign_name = campaign;

    if (date_from || date_to) {
      filter.createdAt = {};
      if (date_from) filter.createdAt.$gte = new Date(date_from + 'T00:00:00.000Z');
      if (date_to) filter.createdAt.$lte = new Date(date_to + 'T23:59:59.999Z');
    }

    // Role check: sales can only export their own assigned leads
    if (req.user.role === 'sales') {
      filter.assigned_to = req.user._id;
    }

    const orderDir = (String(sort_order || '').toLowerCase() === 'asc') ? 1 : -1;
    let sortObj = { createdAt: orderDir };
    if (sort_by === 'follow_up_date' || sort_by === 'followup') {
      sortObj = { follow_up_date: orderDir, createdAt: -1 };
    } else if (sort_by === 'name') {
      sortObj = { name: orderDir, createdAt: -1 };
    } else if (sort_by === 'status') {
      sortObj = { status: orderDir, createdAt: -1 };
    }

    const leadsRaw = await Lead.find(filter).populate('assigned_to', 'name email').sort(sortObj);
    const leads = leadsRaw.map(formatLead);
    await attachLastEnteredRemarks(leads);
    const buffer = exportLeadsToExcelBuffer(leads);

    const isSelected = !!rawIds;
    const fileName = isSelected
      ? `selected_leads_export_${getISTDateString()}.xlsx`
      : `leads_export_${getISTDateString()}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Lead export error:', err);
    return res.status(500).json({ error: 'Failed to export leads.' });
  }
};

router.get('/export', exportLeadsHandler);
router.post('/export', exportLeadsHandler);

/**
 * GET /api/leads
 * List leads with pagination, search, and filters.
 * Sales team users only get leads assigned to them.
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      status = 'all',
      assigned_to = 'all',
      city = 'all',
      source = 'all',
      campaign = 'all',
      date_from = '',
      date_to = '',
      followup_filter = 'all', // all | today | overdue | upcoming
      sort_by = 'created_at',
      sort_order = 'desc'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(10000, parseInt(limit, 10) || 10000));
    const offset = (pageNum - 1) * pageSize;

    const filter = {};

    // Role-based visibility
    if (req.user.role === 'sales') {
      filter.assigned_to = req.user._id;
    } else if (assigned_to !== 'all') {
      if (assigned_to === 'unassigned') {
        filter.$or = [
          { assigned_to: { $size: 0 } },
          { assigned_to: null },
          { assigned_to: { $exists: false } }
        ];
      } else if (mongoose.Types.ObjectId.isValid(assigned_to)) {
        filter.assigned_to = assigned_to;
      }
    }

    if (search && search.trim()) {
      const s = search.trim();
      const searchOr = [
        { name: { $regex: s, $options: 'i' } },
        { phone: { $regex: s, $options: 'i' } },
        { email: { $regex: s, $options: 'i' } },
        { company: { $regex: s, $options: 'i' } }
      ];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    if (status !== 'all') {
      filter.status = status;
    }

    if (city !== 'all') {
      filter.city = city;
    }

    if (source !== 'all') {
      filter.source = source;
    }

    if (campaign !== 'all') {
      filter.campaign_name = campaign;
    }

    if (date_from || date_to) {
      filter.createdAt = {};
      if (date_from) filter.createdAt.$gte = new Date(date_from + 'T00:00:00.000Z');
      if (date_to) filter.createdAt.$lte = new Date(date_to + 'T23:59:59.999Z');
    }

    // Follow-up status filter
    const todayStr = new Date().toISOString().split('T')[0];
    if (followup_filter === 'today') {
      filter.follow_up_date = todayStr;
    } else if (followup_filter === 'overdue') {
      filter.follow_up_date = { $ne: null, $lt: todayStr };
      filter.status = { $nin: ['Won', 'Lost'] };
    } else if (followup_filter === 'upcoming') {
      filter.follow_up_date = { $gt: todayStr };
    }

    // Total Count
    const total = await Lead.countDocuments(filter);

    // Sorting order
    const orderDir = (String(sort_order || '').toLowerCase() === 'asc') ? 1 : -1;
    let sortObj = { createdAt: orderDir };

    switch (sort_by) {
      case 'created_at':
      case 'date':
        sortObj = { createdAt: orderDir };
        break;
      case 'follow_up_date':
      case 'followup':
        sortObj = { follow_up_date: orderDir, createdAt: -1 };
        break;
      case 'updated_at':
        sortObj = { updatedAt: orderDir };
        break;
      case 'name':
        sortObj = { name: orderDir };
        break;
      case 'status':
        sortObj = { status: orderDir, createdAt: -1 };
        break;
      default:
        sortObj = { createdAt: orderDir };
        break;
    }

    // Fetch Rows with multi-assigned names and IDs
    const leadsRaw = await Lead.find(filter)
      .populate('assigned_to', 'name email phone')
      .sort(sortObj)
      .skip(offset)
      .limit(pageSize);

    const leads = leadsRaw.map(formatLead);
    await attachLastEnteredRemarks(leads);

    // Unique cities, sources, and campaigns for filter dropdowns
    const [availableCities, availableSources, availableCampaigns] = await Promise.all([
      Lead.distinct('city', { city: { $nin: [null, ''] } }),
      Lead.distinct('source', { source: { $nin: [null, ''] } }),
      Lead.distinct('campaign_name', { campaign_name: { $nin: [null, ''] } })
    ]);

    availableCities.sort();
    availableSources.sort();
    availableCampaigns.sort();

    return res.json({
      leads,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      },
      availableCities,
      availableSources,
      availableCampaigns
    });
  } catch (err) {
    console.error('Fetch leads error:', err);
    return res.status(500).json({ error: 'Failed to retrieve leads.' });
  }
});

/**
 * GET /api/leads/meta/campaigns
 * Get distinct campaigns with lead counts and conversion metrics
 */
router.get('/meta/campaigns', async (req, res) => {
  try {
    const isSales = req.user.role === 'sales';
    const match = isSales ? { assigned_to: req.user._id } : {};

    const campaignsAgg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$campaign_name', 'Meta Ads - General'] },
          total_leads: { $sum: 1 },
          won_leads: { $sum: { $cond: [{ $eq: ['$status', 'Won'] }, 1, 0] } },
          lost_leads: { $sum: { $cond: [{ $eq: ['$status', 'Lost'] }, 1, 0] } },
          new_leads: { $sum: { $cond: [{ $eq: ['$status', 'New'] }, 1, 0] } },
          pipeline_leads: {
            $sum: {
              $cond: [
                { $in: ['$status', ['Interested', 'Quotation Sent', 'Follow-up']] },
                1,
                0
              ]
            }
          }
        }
      },
      { $sort: { total_leads: -1 } }
    ]);

    const campaigns = campaignsAgg.map(c => ({
      campaign: c._id,
      total_leads: c.total_leads,
      won_leads: c.won_leads,
      lost_leads: c.lost_leads,
      new_leads: c.new_leads,
      pipeline_leads: c.pipeline_leads
    }));

    return res.json({ campaigns });
  } catch (err) {
    console.error('Fetch campaigns error:', err);
    return res.status(500).json({ error: 'Failed to retrieve campaigns.' });
  }
});

/**
 * GET /api/leads/:id
 * Retrieve a single lead with full activity history timeline
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const leadDoc = await Lead.findById(id).populate('assigned_to', 'name email phone');
    if (!leadDoc) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const lead = formatLead(leadDoc);

    // Role check: sales team can only view their own assigned lead
    if (req.user.role === 'sales') {
      const isAssigned = (leadDoc.assigned_to || []).some(
        u => (u._id ? u._id.toString() : String(u)) === req.user._id.toString()
      );
      if (!isAssigned) {
        return res.status(403).json({ error: 'Access denied: You can only view leads assigned to you.' });
      }
    }

    // Fetch activity history
    const activitiesRaw = await LeadActivity.find({ lead_id: leadDoc._id }).sort({ createdAt: -1 });
    const activities = activitiesRaw.map(a => ({
      id: a._id.toString(),
      _id: a._id.toString(),
      lead_id: a.lead_id.toString(),
      user_id: a.user_id ? a.user_id.toString() : null,
      user_name: a.user_name || '',
      old_status: a.old_status,
      new_status: a.new_status,
      notes: a.notes || '',
      created_at: a.createdAt
    }));

    return res.json({ lead, activities });
  } catch (err) {
    console.error('Fetch lead detail error:', err);
    return res.status(500).json({ error: 'Failed to fetch lead details.' });
  }
});

/**
 * POST /api/leads
 * Create a new lead manually (Admin only)
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      phone,
      whatsapp,
      email,
      company,
      city,
      product_interest,
      campaign_name = 'Meta Ads - General',
      source = 'Manual Entry',
      assigned_to = null,
      assigned_to_users = [],
      status = 'New',
      remarks,
      follow_up_date
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Lead name and phone number are required.' });
    }

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 5) {
      return res.status(400).json({ error: 'Invalid phone number.' });
    }

    // Check duplicate phone
    const existing = await Lead.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ error: 'A lead with this phone number already exists.' });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    // Resolve target assigned user IDs
    let userIds = Array.isArray(assigned_to_users) ? assigned_to_users.filter(id => mongoose.Types.ObjectId.isValid(id)) : [];
    if (userIds.length === 0 && assigned_to && mongoose.Types.ObjectId.isValid(assigned_to)) {
      userIds.push(assigned_to);
    }

    let validUsers = [];
    if (userIds.length > 0) {
      validUsers = await User.find({ _id: { $in: userIds }, is_active: true });
    }

    const assignedObjectIds = validUsers.map(u => u._id);
    const assignedNames = validUsers.map(u => u.name).join(', ');
    const cleanWhatsApp = whatsapp ? normalizePhone(whatsapp) : cleanPhone;

    const newLead = await Lead.create({
      name: name.trim(),
      phone: cleanPhone,
      whatsapp: cleanWhatsApp,
      email: email ? email.trim() : '',
      company: company ? company.trim() : '',
      city: city ? city.trim() : '',
      product_interest: product_interest ? product_interest.trim() : '',
      campaign_name: campaign_name ? campaign_name.trim() : 'Meta Ads - General',
      source: source || 'Manual Entry',
      assigned_to: assignedObjectIds,
      status: status || 'New',
      remarks: remarks ? remarks.trim() : '',
      follow_up_date: follow_up_date || null
    });

    // Add activity entry
    await LeadActivity.create({
      lead_id: newLead._id,
      user_id: req.user._id,
      user_name: req.user.name,
      old_status: null,
      new_status: status || 'New',
      notes: validUsers.length > 0 ? `Lead created and assigned to ${assignedNames}` : 'Lead created manually'
    });

    const populated = await Lead.findById(newLead._id).populate('assigned_to', 'name email phone');

    return res.status(201).json({
      message: 'Lead created successfully.',
      lead: formatLead(populated)
    });
  } catch (err) {
    console.error('Create lead error:', err);
    return res.status(500).json({ error: 'Failed to create lead.' });
  }
});

/**
 * PUT /api/leads/:id
 * Edit lead details (Admin can edit all; Sales rep can update status, remarks, follow-up date)
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const existing = await Lead.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    // Role permission check: must be assigned to sales rep
    if (req.user.role === 'sales') {
      const isAssigned = (existing.assigned_to || []).some(
        uid => uid.toString() === req.user._id.toString()
      );
      if (!isAssigned) {
        return res.status(403).json({ error: 'Access denied: You can only edit your assigned leads.' });
      }
    }

    const {
      name,
      phone,
      whatsapp,
      email,
      company,
      city,
      product_interest,
      campaign_name,
      source,
      assigned_to,
      assigned_to_users,
      status,
      remarks,
      follow_up_date,
      activity_note
    } = req.body;

    const oldStatus = existing.status;
    const newStatus = status || oldStatus;

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    // Check duplicate phone if updating phone (Admin only)
    let cleanPhone = existing.phone;
    if (req.user.role === 'admin' && phone) {
      cleanPhone = normalizePhone(phone);
      const duplicate = await Lead.findOne({ phone: cleanPhone, _id: { $ne: existing._id } });
      if (duplicate) {
        return res.status(400).json({ error: 'Phone number already registered to another lead.' });
      }
    }

    if (req.user.role === 'admin') {
      let targetUserIds = null;
      if (assigned_to_users !== undefined) {
        targetUserIds = Array.isArray(assigned_to_users) ? assigned_to_users.filter(uid => mongoose.Types.ObjectId.isValid(uid)) : [];
      } else if (assigned_to !== undefined) {
        targetUserIds = (assigned_to && mongoose.Types.ObjectId.isValid(assigned_to)) ? [assigned_to] : [];
      }

      if (name !== undefined) existing.name = name.trim();
      if (phone !== undefined) existing.phone = cleanPhone;
      if (whatsapp !== undefined) existing.whatsapp = whatsapp ? normalizePhone(whatsapp) : cleanPhone;
      if (email !== undefined) existing.email = email ? email.trim() : '';
      if (company !== undefined) existing.company = company ? company.trim() : '';
      if (city !== undefined) existing.city = city ? city.trim() : '';
      if (product_interest !== undefined) existing.product_interest = product_interest ? product_interest.trim() : '';
      if (campaign_name !== undefined) existing.campaign_name = campaign_name ? campaign_name.trim() : 'Meta Ads - General';
      if (source !== undefined) existing.source = source || 'Direct';
      if (targetUserIds !== null) {
        existing.assigned_to = targetUserIds;
      }
      existing.status = newStatus;
      if (remarks !== undefined) existing.remarks = remarks ? remarks.trim() : '';
      if (follow_up_date !== undefined) existing.follow_up_date = follow_up_date || null;
    } else {
      // Sales team: can update status, remarks, follow_up_date, campaign_name
      existing.status = newStatus;
      if (campaign_name !== undefined) existing.campaign_name = campaign_name ? campaign_name.trim() : 'Meta Ads - General';
      if (remarks !== undefined) existing.remarks = remarks ? remarks.trim() : '';
      if (follow_up_date !== undefined) existing.follow_up_date = follow_up_date || null;
    }

    await existing.save();

    // Record Activity History if status changed or note provided
    const statusChanged = oldStatus !== newStatus;
    const noteProvided = !!activity_note;

    if (statusChanged || noteProvided) {
      let noteText = activity_note || '';
      if (statusChanged && !noteProvided) {
        noteText = `Status changed from "${oldStatus}" to "${newStatus}"`;
      }

      await LeadActivity.create({
        lead_id: existing._id,
        user_id: req.user._id,
        user_name: req.user.name,
        old_status: oldStatus,
        new_status: newStatus,
        notes: noteText
      });
    }

    const updated = await Lead.findById(existing._id).populate('assigned_to', 'name email phone');

    return res.json({
      message: 'Lead updated successfully.',
      lead: formatLead(updated)
    });
  } catch (err) {
    console.error('Update lead error:', err);
    return res.status(500).json({ error: 'Failed to update lead.' });
  }
});

/**
 * POST /api/leads/:id/activity
 * Add a note or status change to the lead activity history
 */
router.post('/:id/activity', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    if (req.user.role === 'sales') {
      const isAssigned = (lead.assigned_to || []).some(
        uid => uid.toString() === req.user._id.toString()
      );
      if (!isAssigned) {
        return res.status(403).json({ error: 'Access denied: You can only update your assigned leads.' });
      }
    }

    const { status, note, follow_up_date } = req.body;
    const oldStatus = lead.status;
    const newStatus = status || oldStatus;

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    lead.status = newStatus;
    if (follow_up_date !== undefined) {
      lead.follow_up_date = follow_up_date || null;
    }
    const trimmedNote = (note || '').trim();
    if (trimmedNote) {
      const lower = trimmedNote.toLowerCase();
      const isAuto = lower.startsWith('status updated to') ||
        lower.startsWith('updated lead status to') ||
        lower.startsWith('follow-up date set to');
      if (!isAuto) {
        lead.remarks = trimmedNote;
      }
    }
    await lead.save();

    await LeadActivity.create({
      lead_id: lead._id,
      user_id: req.user._id,
      user_name: req.user.name,
      old_status: oldStatus,
      new_status: newStatus,
      notes: note || `Status updated to ${newStatus}`
    });

    const activitiesRaw = await LeadActivity.find({ lead_id: lead._id }).sort({ createdAt: -1 });
    const activities = activitiesRaw.map(a => ({
      id: a._id.toString(),
      _id: a._id.toString(),
      lead_id: a.lead_id.toString(),
      user_id: a.user_id ? a.user_id.toString() : null,
      user_name: a.user_name || '',
      old_status: a.old_status,
      new_status: a.new_status,
      notes: a.notes || '',
      created_at: a.createdAt
    }));

    return res.json({
      message: 'Activity recorded successfully.',
      activities
    });
  } catch (err) {
    console.error('Add activity error:', err);
    return res.status(500).json({ error: 'Failed to add activity.' });
  }
});

/**
 * DELETE /api/leads/:id
 * Delete a lead (Admin only)
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    await Lead.deleteOne({ _id: lead._id });
    await LeadActivity.deleteMany({ lead_id: lead._id });

    return res.json({ message: `Lead "${lead.name}" deleted successfully.` });
  } catch (err) {
    console.error('Delete lead error:', err);
    return res.status(500).json({ error: 'Failed to delete lead.' });
  }
});

/**
 * POST /api/leads/bulk-assign
 * Bulk assign leads to one or multiple salespersons (Admin only)
 * Supports:
 * - mode = 'distribute' (Round-robin / split leads evenly across selected salespersons)
 * - mode = 'coassign' (Assign all selected salespersons to each of the selected leads)
 * - mode = 'unassign' (Clear assignments)
 */
router.post('/bulk-assign', requireAdmin, async (req, res) => {
  try {
    const {
      lead_ids,
      assigned_to_users = [],
      assigned_to,
      mode = 'distribute'
    } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'No lead IDs provided for assignment.' });
    }

    const validLeadIds = lead_ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validLeadIds.length === 0) {
      return res.status(400).json({ error: 'No valid lead IDs provided.' });
    }

    let targetUserIds = Array.isArray(assigned_to_users) ? [...assigned_to_users] : [];
    if (targetUserIds.length === 0 && assigned_to) {
      targetUserIds.push(assigned_to);
    }

    targetUserIds = targetUserIds.filter(id => mongoose.Types.ObjectId.isValid(id));

    // Unassign mode
    if (targetUserIds.length === 0 || mode === 'unassign') {
      const leads = await Lead.find({ _id: { $in: validLeadIds } });
      await Lead.updateMany(
        { _id: { $in: validLeadIds } },
        { $set: { assigned_to: [] } }
      );

      const activityDocs = leads.map(l => ({
        lead_id: l._id,
        user_id: req.user._id,
        user_name: req.user.name,
        old_status: l.status,
        new_status: l.status,
        notes: 'Lead unassigned by administrator'
      }));
      if (activityDocs.length > 0) {
        await LeadActivity.insertMany(activityDocs);
      }

      return res.json({
        message: `Successfully unassigned ${validLeadIds.length} leads.`
      });
    }

    // Validate selected users
    const validUsers = await User.find({ _id: { $in: targetUserIds }, is_active: true });
    if (validUsers.length === 0) {
      return res.status(400).json({ error: 'Selected sales representatives do not exist or are inactive.' });
    }

    if (mode === 'distribute') {
      // Round-robin distribution
      for (let i = 0; i < validLeadIds.length; i++) {
        const leadId = validLeadIds[i];
        const targetUser = validUsers[i % validUsers.length];

        const existingLead = await Lead.findByIdAndUpdate(
          leadId,
          { $set: { assigned_to: [targetUser._id] } }
        );

        if (existingLead) {
          await LeadActivity.create({
            lead_id: leadId,
            user_id: req.user._id,
            user_name: req.user.name,
            old_status: existingLead.status,
            new_status: existingLead.status,
            notes: `Assigned to ${targetUser.name} (Round-Robin distribution across ${validUsers.length} reps)`
          });
        }
      }
    } else {
      // Co-assign mode
      const allUserIds = validUsers.map(u => u._id);
      const allNames = validUsers.map(u => u.name).join(', ');

      const leads = await Lead.find({ _id: { $in: validLeadIds } });
      await Lead.updateMany(
        { _id: { $in: validLeadIds } },
        { $set: { assigned_to: allUserIds } }
      );

      const activityDocs = leads.map(l => ({
        lead_id: l._id,
        user_id: req.user._id,
        user_name: req.user.name,
        old_status: l.status,
        new_status: l.status,
        notes: `Co-assigned to: ${allNames}`
      }));
      if (activityDocs.length > 0) {
        await LeadActivity.insertMany(activityDocs);
      }
    }

    const userNamesList = validUsers.map(u => u.name).join(', ');
    const modeDesc = mode === 'distribute'
      ? `distributed evenly across ${validUsers.length} sales reps (${userNamesList})`
      : `co-assigned to ${validUsers.length} sales reps (${userNamesList})`;

    return res.json({
      message: `Successfully ${modeDesc} for ${validLeadIds.length} leads.`
    });
  } catch (err) {
    console.error('Bulk assign error:', err);
    return res.status(500).json({ error: 'Failed to bulk assign leads.' });
  }
});

/**
 * POST /api/leads/bulk-status
 * Bulk update status for selected leads
 */
router.post('/bulk-status', async (req, res) => {
  try {
    const { lead_ids, status, note } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'No lead IDs provided.' });
    }

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Valid status is required.' });
    }

    const validLeadIds = lead_ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    const filter = { _id: { $in: validLeadIds } };
    if (req.user.role === 'sales') {
      filter.assigned_to = req.user._id;
    }

    const targetLeads = await Lead.find(filter);
    if (targetLeads.length === 0) {
      return res.status(400).json({ error: 'No matching authorized leads to update.' });
    }

    const targetIds = targetLeads.map(l => l._id);
    await Lead.updateMany({ _id: { $in: targetIds } }, { $set: { status } });

    const activityDocs = targetLeads.map(lead => ({
      lead_id: lead._id,
      user_id: req.user._id,
      user_name: req.user.name,
      old_status: lead.status,
      new_status: status,
      notes: note || `Bulk status update to ${status}`
    }));

    if (activityDocs.length > 0) {
      await LeadActivity.insertMany(activityDocs);
    }

    return res.json({
      message: `Successfully updated status to "${status}" for ${targetLeads.length} leads.`
    });
  } catch (err) {
    console.error('Bulk status error:', err);
    return res.status(500).json({ error: 'Failed to bulk update status.' });
  }
});

/**
 * POST /api/leads/bulk-campaign
 * Bulk categorize leads under an Ad Campaign (Admin only)
 */
router.post('/bulk-campaign', requireAdmin, async (req, res) => {
  try {
    const { lead_ids, campaign_name } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'No lead IDs provided.' });
    }

    if (!campaign_name || !campaign_name.trim()) {
      return res.status(400).json({ error: 'Ad Campaign name is required.' });
    }

    const cleanCampaign = campaign_name.trim();
    const validLeadIds = lead_ids.filter(id => mongoose.Types.ObjectId.isValid(id));

    const leads = await Lead.find({ _id: { $in: validLeadIds } });
    await Lead.updateMany(
      { _id: { $in: validLeadIds } },
      { $set: { campaign_name: cleanCampaign } }
    );

    const activityDocs = leads.map(l => ({
      lead_id: l._id,
      user_id: req.user._id,
      user_name: req.user.name,
      old_status: l.status,
      new_status: l.status,
      notes: `Ad Campaign categorized as: "${cleanCampaign}"`
    }));

    if (activityDocs.length > 0) {
      await LeadActivity.insertMany(activityDocs);
    }

    return res.json({
      message: `Successfully categorized ${leads.length} leads under campaign "${cleanCampaign}".`
    });
  } catch (err) {
    console.error('Bulk campaign error:', err);
    return res.status(500).json({ error: 'Failed to bulk categorize leads by campaign.' });
  }
});

/**
 * POST /api/leads/campaign/rename
 * Rename a campaign across all leads that belong to it (Admin only)
 */
router.post('/campaign/rename', requireAdmin, async (req, res) => {
  try {
    const { old_campaign, new_campaign } = req.body;

    if (!old_campaign || !new_campaign || !new_campaign.trim()) {
      return res.status(400).json({ error: 'Both old and new campaign names are required.' });
    }

    const cleanOld = old_campaign.trim();
    const cleanNew = new_campaign.trim();

    const result = await Lead.updateMany(
      { campaign_name: cleanOld },
      { $set: { campaign_name: cleanNew } }
    );

    return res.json({
      message: `Successfully renamed campaign from "${cleanOld}" to "${cleanNew}" across ${result.modifiedCount} lead(s).`,
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('Rename campaign error:', err);
    return res.status(500).json({ error: 'Failed to rename campaign.' });
  }
});

/**
 * POST /api/leads/bulk-delete
 * Bulk delete leads (Admin only)
 */
router.post('/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const { lead_ids } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'No lead IDs provided for deletion.' });
    }

    const validLeadIds = lead_ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    const result = await Lead.deleteMany({ _id: { $in: validLeadIds } });
    await LeadActivity.deleteMany({ lead_id: { $in: validLeadIds } });

    return res.json({
      message: `Successfully deleted ${result.deletedCount} leads.`
    });
  } catch (err) {
    console.error('Bulk delete error:', err);
    return res.status(500).json({ error: 'Failed to bulk delete leads.' });
  }
});

export default router;
