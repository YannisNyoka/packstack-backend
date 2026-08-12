import mongoose from 'mongoose';

const { Schema } = mongoose;

// Not tenant-scoped - a small, mostly-static reference table of what tenants
// can subscribe to, managed by platform superadmins only.
const planSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    priceZAR: { type: Number, required: true, min: 0 },
    billingInterval: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    limits: {
      maxStaff: { type: Number, required: true, min: 1 },
      maxAppointmentsPerMonth: { type: Number, required: true, min: 1 },
      whatsappMessagesPerMonth: { type: Number, required: true, min: 0 },
      customDomainAllowed: { type: Boolean, default: false },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Plan = mongoose.models.Plan || mongoose.model('Plan', planSchema);
