import { Service } from '../models/Service.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

export async function listServices({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { active: true };
  return Service.find(filter).sort({ category: 1, name: 1 });
}

export async function getServiceById(id) {
  const service = await Service.findById(id);
  if (!service) throw ApiError.notFound('Service not found');
  return service;
}

export async function createService({ req, actorUserId, data }) {
  const service = await Service.create(data);
  await logAudit({ req, actorUserId, action: 'service.create', entityType: 'Service', entityId: service._id, diff: { after: data } });
  return service;
}

export async function updateService({ req, actorUserId, id, data }) {
  const before = await getServiceById(id);
  Object.assign(before, data);
  await before.save();
  await logAudit({
    req,
    actorUserId,
    action: 'service.update',
    entityType: 'Service',
    entityId: id,
    diff: { before: before.toObject(), after: data },
  });
  return before;
}

export async function setServiceActive({ req, actorUserId, id, active }) {
  return updateService({ req, actorUserId, id, data: { active } });
}
