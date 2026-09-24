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
    // The PayFast pf_payment_id most recently applied by handlePayfastItn -
    // PayFast can and does redeliver the same ITN (their documented retry
    // behavior on an ambiguous response), and without this a redelivery of
    // an already-applied COMPLETE/FAILED notification would reprocess as if
    // it were new: pushing currentPeriodEnd or gracePeriodEndsAt out again
    // from the redelivery's own "now" with no corresponding second charge.
    // Comparing against this field before transitioning makes a true replay
    // a clean no-op. See billingService.js#handlePayfastItn.
    lastProcessedPfPaymentId: { type: String, default: null },
  },
  { timestamps: true, optimisticConcurrency: true }
);

subscriptionSchema.plugin(tenantScopePlugin, { uniquePerTenant: true });

export const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
