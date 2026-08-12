import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorType: { type: String, enum: ['user', 'superadmin'], default: 'user' },
    action: { type: String, required: true }, // e.g. 'appointment.cancel', 'payment.status_change', 'auth.login_failed'
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    diff: { type: Schema.Types.Mixed, default: null }, // { before, after } snapshot
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

auditLogSchema.plugin(tenantScopePlugin);
auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, entityType: 1, entityId: 1 });

// Append-only: no route in this codebase should ever update or delete an
// audit log entry. Blocking it here too means that stays true even if a
// future route accidentally tries.
for (const method of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditLogSchema.statics[method] = function disabledMutation() {
    throw new Error(`AuditLog is append-only: ${method}() is disabled.`);
  };
}

export const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
