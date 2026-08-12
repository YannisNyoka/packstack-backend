import mongoose from 'mongoose';

const { Schema } = mongoose;

// Deliberately NOT tenant-scoped (no tenantScopePlugin), same reasoning as
// Tenant/Plan: resolving a request's tenant from an arbitrary custom domain
// (see routes/publicDomainRoutes.js) has to happen *before* any tenant
// context can exist - it's one of the two ways a request identifies its
// tenant in the first place, alongside the subdomain slug. A tenant-scoped
// query would refuse to run with no context bound, which is exactly the
// case this lookup runs in. `tenantId` is a plain ref instead; every
// owner-facing query in services/domainService.js filters by it explicitly,
// since the plugin isn't here to enforce that automatically.
//
// `domain` is deliberately globally unique (not compounded with tenantId):
// two tenants can never legitimately claim the same custom domain, so this
// is the one intentional exception to the "always scope uniqueness by
// tenantId" rule elsewhere in this codebase.
const domainMappingSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    domain: { type: String, required: true, trim: true, lowercase: true, unique: true },
    verified: { type: Boolean, default: false },
    verificationToken: { type: String, default: null, select: false },
    sslStatus: { type: String, enum: ['pending', 'issued', 'failed'], default: 'pending' },
  },
  { timestamps: true }
);

export const DomainMapping = mongoose.models.DomainMapping || mongoose.model('DomainMapping', domainMappingSchema);
