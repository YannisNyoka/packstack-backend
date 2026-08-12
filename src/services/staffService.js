import { StaffMember } from '../models/StaffMember.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

export async function listStaff({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { active: true };
  return StaffMember.find(filter).sort({ name: 1 });
}

export async function getStaffById(id) {
  const staff = await StaffMember.findById(id);
  if (!staff) throw ApiError.notFound('Staff member not found');
  return staff;
}

async function assertWithinStaffPlanLimit() {
  const subscription = await Subscription.findOne({});
  if (!subscription) return; // no subscription yet (e.g. trial without one provisioned) - don't block
  const plan = await Plan.findById(subscription.planId);
  if (!plan) return;

  const activeStaffCount = await StaffMember.countDocuments({ active: true });
  if (activeStaffCount >= plan.limits.maxStaff) {
    throw ApiError.forbidden(`Your plan allows up to ${plan.limits.maxStaff} staff members. Upgrade to add more.`, {
      code: 'PLAN_LIMIT_STAFF',
    });
  }
}

export async function createStaffMember({ req, actorUserId, data }) {
  await assertWithinStaffPlanLimit();
  const staff = await StaffMember.create(data);
  await logAudit({ req, actorUserId, action: 'staff.create', entityType: 'StaffMember', entityId: staff._id, diff: { after: data } });
  return staff;
}

export async function updateStaffMember({ req, actorUserId, id, data }) {
  const staff = await getStaffById(id);
  const before = staff.toObject();
  Object.assign(staff, data);
  await staff.save();
  await logAudit({ req, actorUserId, action: 'staff.update', entityType: 'StaffMember', entityId: id, diff: { before, after: data } });
  return staff;
}
