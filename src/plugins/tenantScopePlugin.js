import mongoose from 'mongoose';
import { getCurrentTenantId } from '../lib/tenantContext.js';

export class TenantScopeViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantScopeViolationError';
    this.statusCode = 500;
  }
}

// Query-type middleware only. Instance methods (doc.save(), doc.deleteOne())
// are intentionally out of scope here — application code must go through
// Model statics (Model.create/find/updateOne/etc.), which is the convention
// enforced by the service layer (see src/services/*). Document creation via
// `new Model(...).save()` is still covered, via the pre('validate') hook below,
// which fires for both .save() and .insertMany().
const QUERY_HOOKS = [
  'count',
  'countDocuments',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndRemove',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'distinct',
];

function applyTenantScopeToQuery(query) {
  const tenantId = getCurrentTenantId();
  const filter = query.getFilter();

  if (filter.tenantId !== undefined && String(filter.tenantId) !== tenantId) {
    throw new TenantScopeViolationError(
      `Refusing to execute query: filter targets tenant ${filter.tenantId} but current context is tenant ${tenantId}.`
    );
  }
  query.where({ tenantId });

  if (typeof query.getUpdate === 'function') {
    const update = query.getUpdate();
    if (update) {
      if (update.tenantId !== undefined && String(update.tenantId) !== tenantId) {
        throw new TenantScopeViolationError('Refusing to execute update: payload attempts to change tenantId.');
      }
      delete update.tenantId;
      if (update.$set) delete update.$set.tenantId;
      if (update.$setOnInsert) update.$setOnInsert.tenantId = tenantId;
    }
  }
}

/**
 * Pass { uniquePerTenant: true } for models that are 1:1 with a tenant
 * (Subscription, ThemeConfig) instead of also adding a separate
 * schema.index({ tenantId: 1 }, { unique: true }) - the latter produces a
 * second index with an identical key pattern to this plugin's own tenantId
 * index, which Mongoose flags as a duplicate index at startup.
 */
export function tenantScopePlugin(schema, { uniquePerTenant = false } = {}) {
  schema.add({
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      immutable: true,
      ...(uniquePerTenant ? { unique: true } : { index: true }),
    },
  });

  schema.pre(QUERY_HOOKS, { query: true, document: false }, function tenantScopeQueryHook() {
    applyTenantScopeToQuery(this);
  });

  // Covers both .save() (new documents) and .insertMany() (validate runs
  // per-document for both flows), unlike a 'save' hook which insertMany skips.
  schema.pre('validate', function tenantScopeAssignHook(next) {
    if (!this.tenantId) {
      this.tenantId = getCurrentTenantId();
    }
    next();
  });

  schema.statics.aggregate = function tenantScopedAggregate(pipeline = []) {
    const tenantId = getCurrentTenantId();
    return mongoose.Model.aggregate.call(this, [{ $match: { tenantId: new mongoose.Types.ObjectId(tenantId) } }, ...pipeline]);
  };

  // estimatedDocumentCount() ignores any filter by design, which is exactly
  // the footgun this plugin exists to prevent. Steer callers to countDocuments().
  schema.statics.estimatedDocumentCount = function disabledEstimatedDocumentCount() {
    throw new TenantScopeViolationError(
      'estimatedDocumentCount() ignores tenant scoping and is disabled on tenant-scoped models. Use countDocuments({}) instead.'
    );
  };
}
