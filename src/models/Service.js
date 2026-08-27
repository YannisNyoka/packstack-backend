import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const serviceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    durationMinutes: { type: Number, required: true, min: 5, max: 24 * 60 },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, default: '', trim: true },
    imageUrl: { type: String, default: '', trim: true, maxlength: 500 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

serviceSchema.plugin(tenantScopePlugin);
serviceSchema.index({ tenantId: 1, active: 1 });

export const Service = mongoose.models.Service || mongoose.model('Service', serviceSchema);
