import mongoose from 'mongoose';

const importIssueSchema = new mongoose.Schema({
  row_number:    Number,
  lead_name:     String,
  phone:         String,
  company:       String,
  city:          String,
  campaign_name: String,
  issue_type:    { type: String, enum: ['duplicate', 'validation_error'] },
  reason:        String
}, { _id: false, timestamps: true });

const importBatchSchema = new mongoose.Schema({
  file_name:        { type: String, default: '' },
  total_rows:       { type: Number, default: 0 },
  imported_count:   { type: Number, default: 0 },
  duplicate_count:  { type: Number, default: 0 },
  error_count:      { type: Number, default: 0 },
  imported_by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  imported_by_name: { type: String, default: '' },
  issues:           [importIssueSchema]
}, { timestamps: true });

importBatchSchema.virtual('id').get(function () {
  return this._id.toHexString();
});
importBatchSchema.set('toJSON', { virtuals: true });

export default mongoose.model('ImportBatch', importBatchSchema);
