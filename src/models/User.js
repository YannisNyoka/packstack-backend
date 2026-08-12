import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

// Staff/owner login accounts. Not every schedulable person needs one -
// see StaffMember, which is the schedulable resource and only optionally
// links back to a User.
const userSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner', 'staff'], required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.plugin(tenantScopePlugin);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
