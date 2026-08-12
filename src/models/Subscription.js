import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const subscriptionSchema = new Schema(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    billingProvider: { type: String, enum: ['payfast'], default: 'payfast' },
    billingProviderCustomerId: { type: String, default: null },
    billingProviderSubscriptionToken: { type: String, default: null },
    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'suspended', 'canceled'],
      default: 'trialing',
      index: true,
    },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    gracePeriodEndsAt: { type: Date, default: null },
  },
  { timestamps: true }
);

subscriptionSchema.plugin(tenantScopePlugin, { uniquePerTenant: true });

export const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
