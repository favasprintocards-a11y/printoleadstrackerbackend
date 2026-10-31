import mongoose from 'mongoose';

const leadActivitySchema = new mongoose.Schema({
  lead_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  user_name:  { type: String, default: '' },
  old_status: { type: String, default: null },
  new_status: { type: String, required: true },
  notes:      { type: String, default: '' }
}, { timestamps: true });

leadActivitySchema.index({ lead_id: 1 });

leadActivitySchema.virtual('id').get(function () {
  return this._id.toHexString();
});
leadActivitySchema.set('toJSON', { virtuals: true });

export default mongoose.model('LeadActivity', leadActivitySchema);
