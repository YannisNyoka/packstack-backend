import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

// A one-off exception on top of StaffMember.workingHours' recurring weekly
// schedule - "Thandi is off sick on the 12th" or "out 14:00-16:00 for a
// personal appointment" - without having to touch the weekly schedule itself.
// startTime/endTime null means the whole day is blocked.
const staffTimeOffSchema = new Schema(
  {
    staffMemberId: { type: Schema.Types.ObjectId, ref: 'StaffMember', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // "YYYY-MM-DD", tenant's local date
    startTime: { type: String, default: null, match: /^\d{2}:\d{2}$/ }, // "HH:mm"
    endTime: { type: String, default: null, match: /^\d{2}:\d{2}$/ },
    reason: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true }
);

staffTimeOffSchema.plugin(tenantScopePlugin);
staffTimeOffSchema.index({ tenantId: 1, staffMemberId: 1, date: 1 });

export const StaffTimeOff = mongoose.models.StaffTimeOff || mongoose.model('StaffTimeOff', staffTimeOffSchema);
