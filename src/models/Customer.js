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
  },
  { timestamps: true }
);

customerSchema.plugin(tenantScopePlugin);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
customerSchema.index({ tenantId: 1, name: 1 });

export const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
