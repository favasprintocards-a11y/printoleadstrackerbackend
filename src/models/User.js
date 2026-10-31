import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['admin', 'sales'], required: true },
  phone:     { type: String, trim: true, default: '' },
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

// Virtual 'id' that returns string version of _id
userSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

userSchema.set('toJSON', { virtuals: true });

export default mongoose.model('User', userSchema);
