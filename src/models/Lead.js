import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  whatsapp: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  company: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  product_interest: { type: String, trim: true, default: '' },
  source: { type: String, trim: true, default: 'Direct' },
  campaign_name: { type: String, trim: true, default: 'Meta Ads - General' },
  // Multi-assign: array of user ObjectIds
  assigned_to: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: {
    type: String,
    enum: ['New', 'Contacted', 'Interested', 'Follow-up', 'Quotation Sent', 'Won', 'Lost', 'Not Reachable'],
    default: 'New'
  },
  remarks: { type: String, trim: true, default: '' },
  follow_up_date: { type: String, default: null } // stored as YYYY-MM-DD string
}, { timestamps: true });

leadSchema.index({ assigned_to: 1 });
leadSchema.index({ status: 1 });
leadSchema.index({ campaign_name: 1 });
leadSchema.index({ follow_up_date: 1 });
leadSchema.index({ createdAt: -1 });

leadSchema.virtual('id').get(function () {
  return this._id.toHexString();
});
leadSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Lead', leadSchema);
