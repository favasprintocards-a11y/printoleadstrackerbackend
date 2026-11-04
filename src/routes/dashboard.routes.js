import express from 'express';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import LeadActivity from '../models/LeadActivity.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticate);

/**
 * GET /api/dashboard/stats
 * Dashboard KPI statistics and aggregated metrics (supports optional ?campaign= filter)
 */
router.get('/stats', async (req, res) => {
  try {
    const isSales = req.user.role === 'sales';
    const userId = req.user._id;
    const todayStr = new Date().toISOString().split('T')[0];
    const selectedCampaign = req.query.campaign && req.query.campaign !== 'all' ? req.query.campaign.trim() : null;

    // Base user & campaign filter conditions for Mongoose
    const baseFilter = {};
    const userFilter = {};

    if (isSales) {
      baseFilter.assigned_to = userId;
      userFilter.assigned_to = userId;
    }

    if (selectedCampaign) {
      baseFilter.campaign_name = selectedCampaign;
    }

    // 1. Total Leads for the active campaign scope
    const totalLeads = await Lead.countDocuments(baseFilter);

    // 2. Leads per Status for the active campaign scope
    const statusAgg = await Lead.aggregate([
      { $match: baseFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const statusMap = {
      'New': 0,
      'Contacted': 0,
      'Interested': 0,
      'Follow-up': 0,
      'Quotation Sent': 0,
      'Won': 0,
      'Lost': 0,
      'Not Reachable': 0,
      'Already Customer': 0
    };

    statusAgg.forEach(row => {
      if (row._id && statusMap[row._id] !== undefined) {
        statusMap[row._id] = row.count;
      }
    });

    // 3. Follow-ups Today & Overdue for the active campaign scope
    const followUpsToday = await Lead.countDocuments({
      ...baseFilter,
      follow_up_date: todayStr
    });

    const followUpsOverdue = await Lead.countDocuments({
      ...baseFilter,
      follow_up_date: { $ne: null, $lt: todayStr },
      status: { $nin: ['Won', 'Lost', 'Already Customer'] }
    });

    // 4. Today's Urgent Leads List (top 6 for active campaign scope)
    const urgentLeadsRaw = await Lead.find({
      ...baseFilter,
      $or: [
        { follow_up_date: todayStr },
        { follow_up_date: { $ne: null, $lt: todayStr }, status: { $nin: ['Won', 'Lost'] } }
      ]
    })
      .populate('assigned_to', 'name email phone')
      .sort({ follow_up_date: 1, createdAt: -1 })
      .limit(6);

    const urgentFollowUps = urgentLeadsRaw.map(l => {
      const assignedUsers = Array.isArray(l.assigned_to) ? l.assigned_to : [];
      return {
        id: l._id.toString(),
        name: l.name,
        phone: l.phone,
        company: l.company || '',
        status: l.status,
        follow_up_date: l.follow_up_date,
        remarks: l.remarks || '',
        campaign_name: l.campaign_name || 'Meta Ads - General',
        assigned_user_name: assignedUsers.map(u => u.name).join(', ') || 'Unassigned'
      };
    });

    // 5. Leads per Salesperson (Admin only, filtered by campaign if selected)
    let salesPerformance = [];
    let teamSummary = {
      totalReps: 0,
      totalAssigned: 0,
      totalWon: 0,
      totalPipeline: 0,
      averageWinRate: 0,
      todayFollowups: 0,
      overdueFollowups: 0
    };

    if (!isSales) {
      const salesReps = await User.find({ role: 'sales', is_active: true }).sort({ name: 1 });

      const repMetrics = await Promise.all(salesReps.map(async (u) => {
        const repFilter = { assigned_to: u._id };
        if (selectedCampaign) {
          repFilter.campaign_name = selectedCampaign;
        }

        const [
          total_leads,
          won_leads,
          lost_leads,
          contacted_leads,
          pipeline_leads,
          new_leads,
          today_followups,
          overdue_followups
        ] = await Promise.all([
          Lead.countDocuments(repFilter),
          Lead.countDocuments({ ...repFilter, status: 'Won' }),
          Lead.countDocuments({ ...repFilter, status: 'Lost' }),
          Lead.countDocuments({ ...repFilter, status: 'Contacted' }),
          Lead.countDocuments({ ...repFilter, status: { $in: ['Interested', 'Follow-up', 'Quotation Sent'] } }),
          Lead.countDocuments({ ...repFilter, status: 'New' }),
          Lead.countDocuments({ ...repFilter, follow_up_date: todayStr }),
          Lead.countDocuments({ ...repFilter, follow_up_date: { $ne: null, $lt: todayStr }, status: { $nin: ['Won', 'Lost', 'Already Customer'] } })
        ]);

        return {
          id: u._id.toString(),
          name: u.name,
          email: u.email,
          phone: u.phone || '',
          total_leads,
          won_leads,
          lost_leads,
          contacted_leads,
          pipeline_leads,
          new_leads,
          today_followups,
          overdue_followups
        };
      }));

      // Sort by won_leads DESC, total_leads DESC
      repMetrics.sort((a, b) => b.won_leads - a.won_leads || b.total_leads - a.total_leads);

      salesPerformance = repMetrics.map((sp, idx) => {
        const total = sp.total_leads || 0;
        const won = sp.won_leads || 0;
        const rate = total > 0 ? Math.round((won / total) * 100) : 0;
        return {
          ...sp,
          rank: idx + 1,
          conversion_rate: rate
        };
      });

      const totalAssigned = salesPerformance.reduce((acc, s) => acc + (s.total_leads || 0), 0);
      const totalWon = salesPerformance.reduce((acc, s) => acc + (s.won_leads || 0), 0);
      const totalPipeline = salesPerformance.reduce((acc, s) => acc + (s.pipeline_leads || 0), 0);
      const todayFollowups = salesPerformance.reduce((acc, s) => acc + (s.today_followups || 0), 0);
      const overdueFollowups = salesPerformance.reduce((acc, s) => acc + (s.overdue_followups || 0), 0);
      const avgWinRate = totalAssigned > 0 ? Math.round((totalWon / totalAssigned) * 100) : 0;

      teamSummary = {
        totalReps: salesPerformance.length,
        totalAssigned,
        totalWon,
        totalPipeline,
        averageWinRate: avgWinRate,
        todayFollowups,
        overdueFollowups
      };
    }

    // 6. Source Breakdown for active campaign scope
    const sourceAgg = await Lead.aggregate([
      { $match: baseFilter },
      { $group: { _id: { $ifNull: ['$source', 'Direct'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 }
    ]);
    const sourceBreakdown = sourceAgg.map(r => ({
      source: r._id || 'Direct',
      count: r.count
    }));

    // 7. Campaign Breakdown (Across all accessible leads for easy switching)
    const campaignAgg = await Lead.aggregate([
      { $match: userFilter },
      {
        $group: {
          _id: { $ifNull: ['$campaign_name', 'Meta Ads - General'] },
          total: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ['$status', 'Won'] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ['$status', 'Lost'] }, 1, 0] } },
          new_leads: { $sum: { $cond: [{ $eq: ['$status', 'New'] }, 1, 0] } },
          pipeline: {
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
      { $sort: { total: -1 } }
    ]);

    const campaignBreakdown = campaignAgg.map(r => ({
      campaign: r._id,
      total: r.total,
      won: r.won,
      lost: r.lost,
      new_leads: r.new_leads,
      pipeline: r.pipeline
    }));

    // Global overall total leads (across all campaigns) for comparison
    const overallTotalLeads = await Lead.countDocuments(userFilter);

    // 8. Recent Activity (for active campaign scope)
    let activityLeadIds = null;
    if (isSales || selectedCampaign) {
      activityLeadIds = await Lead.find(baseFilter).distinct('_id');
    }

    const activityFilter = activityLeadIds ? { lead_id: { $in: activityLeadIds } } : {};

    const recentActivitiesRaw = await LeadActivity.find(activityFilter)
      .sort({ createdAt: -1 })
      .limit(6)
      .populate('lead_id', 'name campaign_name');

    const recentActivities = recentActivitiesRaw.map(a => {
      const leadObj = a.lead_id;
      return {
        id: a._id.toString(),
        lead_id: leadObj ? leadObj._id.toString() : null,
        user_name: a.user_name || '',
        old_status: a.old_status,
        new_status: a.new_status,
        notes: a.notes || '',
        created_at: a.createdAt,
        lead_name: leadObj ? leadObj.name : 'Deleted Lead',
        campaign_name: (leadObj && leadObj.campaign_name) ? leadObj.campaign_name : 'Meta Ads - General'
      };
    });

    // Conversion rate for active campaign scope
    const wonCount = statusMap['Won'] || 0;
    const lostCount = statusMap['Lost'] || 0;
    const closedCount = wonCount + lostCount;
    const conversionRate = closedCount > 0 ? ((wonCount / closedCount) * 100).toFixed(1) : '0.0';

    return res.json({
      selectedCampaign: selectedCampaign || 'all',
      overallTotalLeads,
      summary: {
        totalLeads,
        wonCount,
        lostCount,
        followUpsToday,
        followUpsOverdue,
        conversionRate: `${conversionRate}%`,
        statusMap
      },
      urgentFollowUps,
      salesPerformance,
      teamSummary,
      sourceBreakdown,
      campaignBreakdown,
      recentActivities
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    return res.status(500).json({ error: 'Failed to retrieve dashboard analytics.' });
  }
});

export default router;
