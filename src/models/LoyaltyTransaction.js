import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

// Append-only ledger. Customer.loyaltyPoints is a denormalized running total
// for fast reads; this collection is the source of truth / audit trail for
// "why does this customer have this many points."
const loyaltyTransactionSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    pointsDelta: { type: Number, required: true },
    reason: {
      type: String,
      enum: ['earned_booking', 'redeemed', 'manual_adjustment', 'expired'],
      required: true,
    },
    relatedAppointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

loyaltyTransactionSchema.plugin(tenantScopePlugin);

export const LoyaltyTransaction =
  mongoose.models.LoyaltyTransaction || mongoose.model('LoyaltyTransaction', loyaltyTransactionSchema);
