import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: null },
    loyaltyPoints: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '', maxlength: 5000 },

    // Auth fields for the customer-facing account (login, profile, self-
    // service reschedule/cancel) - see customerAuthService.js. A Customer
    // created by the anonymous booking flow (findOrCreateByPhone) has
    // passwordHash: null until they sign up and "claim" that record, which
    // is what preserves their existing appointment history/loyaltyPoints.
    passwordHash: { type: String, select: false, default: null },
    tokenVersion: { type: Number, default: 0 },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

customerSchema.plugin(tenantScopePlugin);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
customerSchema.index({ tenantId: 1, name: 1 });

export const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
