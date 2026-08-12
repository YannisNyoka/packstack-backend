import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

// encryptedValue is produced by lib/crypto.js#encryptSecret and must never be
// selected by default or returned from any API response - use maskedHint for
// display ("WATI: connected, key ending in ****4471").
const integrationCredentialSchema = new Schema(
  {
    provider: { type: String, enum: ['wati', 'yoco', 'resend'], required: true },
    encryptedValue: { type: String, required: true, select: false },
    maskedHint: { type: String, required: true },
    connectedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

integrationCredentialSchema.plugin(tenantScopePlugin);
integrationCredentialSchema.index({ tenantId: 1, provider: 1 }, { unique: true });

export const IntegrationCredential =
  mongoose.models.IntegrationCredential || mongoose.model('IntegrationCredential', integrationCredentialSchema);
