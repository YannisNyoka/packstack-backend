import mongoose from 'mongoose';
import { tenantScopePlugin } from '../plugins/tenantScopePlugin.js';

const { Schema } = mongoose;

const themeConfigSchema = new Schema(
  {
    businessName: { type: String, required: true, trim: true, maxlength: 200 },
    tagline: { type: String, default: '', maxlength: 300 },
    logoUrl: { type: String, default: null },
    bannerUrl: { type: String, default: null },
    // The public landing page's hero section (see packstack-frontend's
    // LandingPage.jsx) - bannerUrl above is the image variant, heroVideoUrls
    // the video variant (rotating carousel of the tenant's own short service
    // clips), heroMediaType picks which one actually renders. heroVideoUrl
    // (singular) is kept for backward compatibility with tenants that
    // uploaded a single hero video before multi-video support existed -
    // heroVideoUrls takes priority when non-empty. heroEnabled lets a tenant
    // skip the hero entirely for a plain header instead ("the option to have
    // a banner or not").
    heroMediaType: { type: String, enum: ['image', 'video'], default: 'image' },
    heroVideoUrl: { type: String, default: null },
    heroVideoUrls: { type: [String], default: [] },
    heroEnabled: { type: Boolean, default: true },
    // Small pill shown over the hero, e.g. "Dube, Soweto - Est. 2019".
    heroBadgeText: { type: String, default: '', maxlength: 100 },
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
      tiktok: { type: String, default: '' },
      website: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

themeConfigSchema.plugin(tenantScopePlugin, { uniquePerTenant: true });

export const ThemeConfig = mongoose.models.ThemeConfig || mongoose.model('ThemeConfig', themeConfigSchema);
