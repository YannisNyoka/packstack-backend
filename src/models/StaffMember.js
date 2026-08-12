import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const staffMemberSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    photoUrl: { type: String, default: null },
    servicesOffered: [{ type: Schema.Types.ObjectId, ref: 'Service' }],
    workingHours: {
      // Keyed by ISO weekday abbreviation; each entry is a list of
      // { start: "HH:mm", end: "HH:mm" } ranges to allow split shifts / breaks.
      mon: [{ start: String, end: String }],
      tue: [{ start: String, end: String }],
      wed: [{ start: String, end: String }],
      thu: [{ start: String, end: String }],
      fri: [{ start: String, end: String }],
      sat: [{ start: String, end: String }],
      sun: [{ start: String, end: String }],
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

staffMemberSchema.plugin(tenantScopePlugin);
staffMemberSchema.index({ tenantId: 1, active: 1 });

export const StaffMember = mongoose.models.StaffMember || mongoose.model('StaffMember', staffMemberSchema);
