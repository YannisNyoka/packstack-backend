import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const rescheduleEventSchema = new Schema(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const appointmentSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    staffMemberId: { type: Schema.Types.ObjectId, ref: 'StaffMember', required: true },
    serviceIds: [{ type: Schema.Types.ObjectId, ref: 'Service', required: true }],
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    status: {
      // 'pending_payment': a deposit checkout is in flight (see
      // services/depositService.js) - holds the slot like a real booking,
      // but isn't confirmed until the Yoco webhook lands. Never reachable
      // when a tenant doesn't require deposits.
      type: String,
      enum: ['pending_payment', 'booked', 'confirmed', 'completed', 'cancelled', 'no_show'],
      default: 'booked',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'paid_cash', 'paid_card', 'paid_online'],
      default: 'unpaid',
    },
    priceSnapshot: { type: Number, required: true, min: 0 },
    notes: { type: String, default: '', maxlength: 5000 },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null },
    rescheduleHistory: [rescheduleEventSchema],
    // Set once services/reminderService.js actually sends a pre-appointment
    // reminder - null means "not sent yet", the guard that keeps the sweep
    // idempotent regardless of how often/rarely the job runs.
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

appointmentSchema.plugin(tenantScopePlugin);
appointmentSchema.index({ tenantId: 1, staffMemberId: 1, startTime: 1 });
appointmentSchema.index({ tenantId: 1, customerId: 1, startTime: -1 });
appointmentSchema.index({ tenantId: 1, status: 1, startTime: 1 });
appointmentSchema.index({ tenantId: 1, reminderSentAt: 1, startTime: 1 });

export const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
