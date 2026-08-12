import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const themeConfigSchema = new Schema(
  {
    businessName: { type: String, required: true, trim: true, maxlength: 200 },
    tagline: { type: String, default: '', maxlength: 300 },
    logoUrl: { type: String, default: null },
    bannerUrl: { type: String, default: null },
    colors: {
      primary: { type: String, default: '#111827' },
      secondary: { type: String, default: '#6B7280' },
      accent: { type: String, default: '#D946EF' },
    },
    contactInfo: {
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
      address: { type: String, default: '' },
    },
    socialLinks: {
      instagram: { type: String, default: '' },
      facebook: { type: String, default: '' },
      whatsapp: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

themeConfigSchema.plugin(tenantScopePlugin, { uniquePerTenant: true });

export const ThemeConfig = mongoose.models.ThemeConfig || mongoose.model('ThemeConfig', themeConfigSchema);
