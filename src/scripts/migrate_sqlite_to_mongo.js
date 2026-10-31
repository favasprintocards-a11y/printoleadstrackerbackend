import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { connectDB } from '../db/connection.js';
import User from '../models/User.js';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import ImportBatch from '../models/ImportBatch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  console.log('🔄 Starting SQLite to MongoDB Atlas Migration...');
  await connectDB();

  const dbPath = path.resolve(__dirname, '../db/leads.db');
  if (!fs.existsSync(dbPath)) {
    console.log('ℹ️ No SQLite database found at:', dbPath);
    process.exit(0);
  }

  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync(dbPath);
  const sqliteDb = new SQL.Database(fileBuffer);

  // Helper to run query and return array of objects
  function queryAll(sql, params = []) {
    const stmt = sqliteDb.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  // 1. Migrate Users
  console.log('\n--- Migrating Users ---');
  const sqliteUsers = queryAll('SELECT * FROM users');
  const userMap = new Map(); // sqliteId -> mongoId

  for (const u of sqliteUsers) {
    let mongoUser = await User.findOne({
      $or: [
        { email: u.email.toLowerCase() },
        { phone: u.phone }
      ]
    });

    if (!mongoUser) {
      mongoUser = await User.create({
        name: u.name,
        email: u.email.toLowerCase(),
        password: u.password,
        role: u.role,
        phone: u.phone || '',
        is_active: u.is_active === 1
      });
      console.log(`  ✓ Created MongoDB User: ${u.name} (${u.email}) [Role: ${u.role}]`);
    } else {
      console.log(`  ✓ Matched existing MongoDB User: ${u.name} (${u.email})`);
    }

    userMap.set(u.id, mongoUser._id);
  }

  // 2. Fetch Lead Assignments
  const allAssignments = queryAll('SELECT * FROM lead_assignments');
  const leadAssignmentsMap = new Map(); // sqliteLeadId -> Set of sqliteUserIds
  for (const la of allAssignments) {
    if (!leadAssignmentsMap.has(la.lead_id)) {
      leadAssignmentsMap.set(la.lead_id, new Set());
    }
    leadAssignmentsMap.get(la.lead_id).add(la.user_id);
  }

  // 3. Migrate Leads
  console.log('\n--- Migrating Leads ---');
  const sqliteLeads = queryAll('SELECT * FROM leads ORDER BY id ASC');
  const leadMap = new Map(); // sqliteLeadId -> mongoLeadId
  let leadsCreated = 0;
  let leadsSkipped = 0;

  for (const l of sqliteLeads) {
    // Resolve assigned user ObjectIds
    const assignedUserIds = new Set();
    if (l.assigned_to && userMap.has(l.assigned_to)) {
      assignedUserIds.add(userMap.get(l.assigned_to));
    }
    const extraUsers = leadAssignmentsMap.get(l.id);
    if (extraUsers) {
      for (const uid of extraUsers) {
        if (userMap.has(uid)) {
          assignedUserIds.add(userMap.get(uid));
        }
      }
    }

    let mongoLead = await Lead.findOne({ phone: l.phone });
    if (!mongoLead) {
      mongoLead = await Lead.create({
        name: l.name,
        phone: l.phone,
        whatsapp: l.whatsapp || l.phone,
        email: l.email || '',
        company: l.company || '',
        city: l.city || '',
        product_interest: l.product_interest || '',
        source: l.source || 'Direct',
        campaign_name: l.campaign_name || 'Meta Ads - General',
        assigned_to: Array.from(assignedUserIds),
        status: l.status || 'New',
        remarks: l.remarks || '',
        follow_up_date: l.follow_up_date || null,
        createdAt: l.created_at ? new Date(l.created_at) : new Date(),
        updatedAt: l.updated_at ? new Date(l.updated_at) : new Date()
      });
      leadsCreated++;
    } else {
      leadsSkipped++;
    }

    leadMap.set(l.id, mongoLead._id);
  }
  console.log(`  ✓ Leads migrated: ${leadsCreated} created, ${leadsSkipped} already existed (Total: ${sqliteLeads.length})`);

  // 4. Migrate Lead Activities
  console.log('\n--- Migrating Lead Activities ---');
  const sqliteActivities = queryAll('SELECT * FROM lead_activities ORDER BY id ASC');
  let activitiesCreated = 0;

  for (const a of sqliteActivities) {
    const mongoLeadId = leadMap.get(a.lead_id);
    if (!mongoLeadId) continue;

    const mongoUserId = a.user_id ? userMap.get(a.user_id) : null;

    // Check if duplicate activity already logged
    const existing = await LeadActivity.findOne({
      lead_id: mongoLeadId,
      notes: a.notes,
      createdAt: a.created_at ? new Date(a.created_at) : undefined
    });

    if (!existing) {
      await LeadActivity.create({
        lead_id: mongoLeadId,
        user_id: mongoUserId || null,
        user_name: a.user_name || '',
        old_status: a.old_status || null,
        new_status: a.new_status,
        notes: a.notes || '',
        createdAt: a.created_at ? new Date(a.created_at) : new Date()
      });
      activitiesCreated++;
    }
  }
  console.log(`  ✓ Lead activities migrated: ${activitiesCreated} (Total SQLite: ${sqliteActivities.length})`);

  // 5. Migrate Import Batches
  console.log('\n--- Migrating Import Batches ---');
  try {
    const sqliteBatches = queryAll('SELECT * FROM import_batches ORDER BY id ASC');
    let batchesCreated = 0;

    for (const b of sqliteBatches) {
      const sqliteIssues = queryAll('SELECT * FROM import_issues WHERE batch_id = ?', [b.id]);
      const mongoUserId = b.imported_by ? userMap.get(b.imported_by) : null;

      const issues = sqliteIssues.map(i => ({
        row_number: i.row_number,
        lead_name: i.lead_name,
        phone: i.phone,
        company: i.company,
        city: i.city,
        campaign_name: i.campaign_name,
        issue_type: i.issue_type,
        reason: i.reason
      }));

      await ImportBatch.create({
        file_name: b.file_name || 'Import',
        total_rows: b.total_rows || 0,
        imported_count: b.imported_count || 0,
        duplicate_count: b.duplicate_count || 0,
        error_count: b.error_count || 0,
        imported_by: mongoUserId || null,
        imported_by_name: b.imported_by_name || 'Admin',
        issues,
        createdAt: b.created_at ? new Date(b.created_at) : new Date()
      });
      batchesCreated++;
    }
    console.log(`  ✓ Import batches migrated: ${batchesCreated}`);
  } catch (err) {
    console.log('  ℹ️ Import batches table skipped or not present:', err.message);
  }

  console.log('\n🎉 SQLite to MongoDB Migration Completed Successfully!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});

