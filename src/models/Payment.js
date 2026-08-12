import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const paymentSchema = new Schema(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['cash', 'card', 'online'], required: true },
    provider: { type: String, enum: ['cash', 'yoco', 'manual'], required: true },
    providerTransactionId: { type: String, default: null },
    status: { type: String, enum: ['pending', 'succeeded', 'failed', 'refunded'], default: 'pending' },
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

paymentSchema.plugin(tenantScopePlugin);

export const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
