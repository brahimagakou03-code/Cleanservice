const { z } = require("zod");

const PAYMENT_TERMS = ["IMMEDIATE", "NET_15", "NET_30", "NET_45", "NET_60"];
const euVatRegex = /^[A-Z]{2}[A-Z0-9]{2,12}$/;

const customerSiteSchema = z.object({
  label: z.string().min(1, "Libellé du site obligatoire."),
  fullAddress: z.string().min(1, "Adresse complète du site obligatoire."),
  isDefault: z.boolean().optional(),
  isShipping: z.boolean().optional(),
  isBilling: z.boolean().optional(),
  contactName: z.string().optional(),
  contactEmail: z.string().email("E-mail du contact invalide.").optional().or(z.literal("")),
  contactPhone: z.string().optional(),
});

const customerSchema = z
  .object({
    companyName: z.string().min(1, "Nom entreprise obligatoire"),
    countryCode: z
      .string()
      .min(2, "Indiquez un code pays sur 2 lettres (ex. FR).")
      .max(2, "Indiquez un code pays sur 2 lettres (ex. FR).")
      .transform((v) => v.toUpperCase()),
    siret: z.string().optional(),
    vatNumber: z.string().optional(),
    email: z.string().email("Email invalide").optional().or(z.literal("")),
    phone: z.string().optional(),
    website: z.string().url("Site web invalide").optional().or(z.literal("")),
    notes: z.string().optional(),
    paymentTerms: z.enum(PAYMENT_TERMS),
    isActive: z.boolean().optional(),
    sites: z.array(customerSiteSchema).min(1, "Au moins un site est obligatoire"),
  })
  .superRefine((data, ctx) => {
    if (data.countryCode === "FR" && data.siret && !/^\d{14}$/.test(data.siret)) {
      ctx.addIssue({ code: "custom", path: ["siret"], message: "Le SIRET FR doit contenir 14 chiffres." });
    }
    if (data.vatNumber && !euVatRegex.test(data.vatNumber.toUpperCase())) {
      ctx.addIssue({ code: "custom", path: ["vatNumber"], message: "Numero de TVA intracommunautaire invalide." });
    }
  });

module.exports = { customerSchema, PAYMENT_TERMS };
