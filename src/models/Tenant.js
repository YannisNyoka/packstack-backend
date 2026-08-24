import mongoose from 'mongoose';

const { Schema } = mongoose;

// Not tenant-scoped (via tenantScopePlugin) - this IS the tenant. Slug is the
// only thing that must be globally unique and is immutable once created,
// since it's baked into the subdomain and any links already sent to customers.
const tenantSchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Slug must be a valid subdomain label'],
      minlength: 3,
      maxlength: 63,
    },
    displayName: { type: String, required: true, trim: true, maxlength: 200 },
    status: {
      type: String,
      enum: ['trial', 'active', 'past_due', 'suspended'],
      default: 'trial',
      index: true,
    },
    // Set once, at provisioning (platformService.provisionTenant) - null on
    // any tenant that predates this field, which deliberately exempts it
    // from services/billingService.js's expireTrials() sweep rather than
    // retroactively enforcing a trial length nobody agreed to.
    trialEndsAt: { type: Date, default: null },
    timezone: { type: String, default: 'Africa/Johannesburg' },
    currency: { type: String, default: 'ZAR' },
    bookingRules: {
      rescheduleWindowHours: { type: Number, default: 36, min: 0 },
      sameDayCutoffTime: { type: String, default: '18:00' }, // "HH:mm", tenant's local time
      cancellationWindowHours: { type: Number, default: 36, min: 0 },
      // A deposit only actually gets collected once Yoco is connected (see
      // services/depositService.js) - depositRequired can be toggled on
      // ahead of that, it just won't do anything until then.
      depositRequired: { type: Boolean, default: false },
      depositAmountZAR: { type: Number, default: 0, min: 0 },
      // Whether a customer must have a PackStack account (signed up/logged
      // in) to book at all, vs. the original anonymous-booking flow
      // (name/phone/email typed in on the spot, no account). Defaults true -
      // matches the account-required behavior already shipped for every
      // tenant; a tenant can explicitly turn this off to restore anonymous
      // booking. See publicRoutes.js and customerAccountRoutes.js.
      requireCustomerAccount: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

export const Tenant = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
