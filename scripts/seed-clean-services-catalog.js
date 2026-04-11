/**
 * Réinitialise le catalogue (produits + catégories + grilles tarifaires client liées aux produits)
 * pour une organisation, puis importe le référentiel CLEAN SERVICES (PDF).
 *
 * Usage :
 *   npm run catalog:reset-clean
 *
 * Cible (une seule organisation) :
 *   CLEAN_SERVICES_ORG_ID=cuid
 *   ou CLEAN_SERVICES_USER_EMAIL=votre@email.com (organisation du compte équipe)
 *   sinon : première organisation en base (peut ne pas être la vôtre).
 *
 * Toutes les organisations (attention : efface le catalogue partout) :
 *   CLEAN_SERVICES_ALL_ORGS=1
 */
require("dotenv").config();
const { PrismaClient, Prisma } = require("@prisma/client");
const { CATALOG_ITEMS } = require("./clean-services-catalog-data");

const prisma = new PrismaClient();

const PARENTS = [
  { slug: "grp-chimie", name: "Chimie & entretien", sortOrder: 1 },
  { slug: "grp-materiel", name: "Matériel & équipement", sortOrder: 2 },
  { slug: "grp-acto", name: "Anti-nuisibles & hygiène ciblée", sortOrder: 3 },
];

/** Slug feuille -> slug parent */
const LEAF_TO_PARENT = {
  "sanitaires-detartrage": "grp-chimie",
  "vitres-surfaces": "grp-chimie",
  "sols-parquets-moquettes": "grp-chimie",
  "inox-metaux": "grp-chimie",
  "parfums-desodorisants": "grp-chimie",
  "textiles-tapis": "grp-chimie",
  "mains-vaisselle": "grp-chimie",
  "detergence-pro-eco": "grp-chimie",
  "microfibres-eponges": "grp-materiel",
  "franges-raclettes-supports": "grp-materiel",
  "balais-pelles-manches": "grp-materiel",
  "sacs-films": "grp-materiel",
  "papier-essuyage": "grp-materiel",
  "seaux-chariots": "grp-materiel",
  "machines-consommables": "grp-materiel",
  "lavage-vitres-pro": "grp-materiel",
  "acto-produits": "grp-acto",
};

const LEAF_META = {
  "sanitaires-detartrage": { name: "Sanitaires & détartrage", sortOrder: 1 },
  "vitres-surfaces": { name: "Vitres & surfaces lisses", sortOrder: 2 },
  "sols-parquets-moquettes": { name: "Sols durs, parquets & moquettes", sortOrder: 3 },
  "inox-metaux": { name: "Inox & métaux", sortOrder: 4 },
  "parfums-desodorisants": { name: "Parfums d’ambiance & désodorisants", sortOrder: 5 },
  "textiles-tapis": { name: "Textiles, tapis & moquettes (2D)", sortOrder: 6 },
  "mains-vaisselle": { name: "Mains, peau & vaisselle", sortOrder: 7 },
  "detergence-pro-eco": { name: "Détergence pro & entretien écologique", sortOrder: 8 },
  "microfibres-eponges": { name: "Microfibres, éponges & tampons", sortOrder: 1 },
  "franges-raclettes-supports": { name: "Franges, raclettes & supports", sortOrder: 2 },
  "balais-pelles-manches": { name: "Balais, pelles & manches", sortOrder: 3 },
  "sacs-films": { name: "Sacs & films poubelle", sortOrder: 4 },
  "papier-essuyage": { name: "Papier hygiénique & essuyage", sortOrder: 5 },
  "seaux-chariots": { name: "Seaux, presses & chariots", sortOrder: 6 },
  "machines-consommables": { name: "Machines & consommables sol", sortOrder: 7 },
  "lavage-vitres-pro": { name: "Lavage de vitres pro (Unger & accessoires)", sortOrder: 8 },
  "acto-produits": { name: "Gamme ACTO", sortOrder: 1 },
};

const UNITS = new Set(["piece", "kilogramme", "litre", "metre", "heure", "carton", "palette"]);

async function resolveTargetOrgIds() {
  if (process.env.CLEAN_SERVICES_ALL_ORGS === "1") {
    const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
    if (!orgs.length) {
      console.error("Aucune organisation en base.");
      process.exit(1);
    }
    console.log("Mode CLEAN_SERVICES_ALL_ORGS :", orgs.length, "organisation(s).");
    return orgs.map((o) => o.id);
  }

  let orgId = process.env.CLEAN_SERVICES_ORG_ID?.trim();
  const rawEmail = process.env.CLEAN_SERVICES_USER_EMAIL?.trim();
  if (!orgId && rawEmail) {
    const hits = await prisma.$queryRaw(
      Prisma.sql`SELECT organizationId FROM User WHERE LOWER(TRIM(COALESCE(email, ''))) = LOWER(TRIM(${rawEmail})) LIMIT 1`
    );
    const row = hits[0];
    if (!row) {
      console.error(`Aucun utilisateur équipe avec l'e-mail : ${rawEmail}`);
      process.exit(1);
    }
    orgId = row.organizationId;
    console.log("Organisation déduite du compte équipe :", rawEmail);
  }
  if (!orgId) {
    orgId = (await prisma.organization.findFirst({ select: { id: true } }))?.id;
    if (orgId) {
      console.warn(
        "Astuce : le catalogue est chargé pour la première organisation en base. Si vous ne voyez rien dans l'admin, définissez CLEAN_SERVICES_USER_EMAIL=votre_email ou CLEAN_SERVICES_ORG_ID."
      );
    }
  }
  if (!orgId) {
    console.error("Aucune organisation trouvée. Créez une org ou définissez CLEAN_SERVICES_ORG_ID / CLEAN_SERVICES_USER_EMAIL.");
    process.exit(1);
  }
  return [orgId];
}

async function seedOneOrganization(orgId) {
  await prisma.$transaction(async (tx) => {
    const productIds = await tx.product.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });
    const ids = productIds.map((p) => p.id);
    if (ids.length) {
      await tx.customerPriceList.deleteMany({
        where: { organizationId: orgId, productId: { in: ids } },
      });
    }
    await tx.product.deleteMany({ where: { organizationId: orgId } });
    await tx.productCategory.deleteMany({ where: { organizationId: orgId } });

    const parentRows = {};
    for (const p of PARENTS) {
      const row = await tx.productCategory.create({
        data: {
          organizationId: orgId,
          slug: p.slug,
          name: p.name,
          sortOrder: p.sortOrder,
          parentId: null,
        },
      });
      parentRows[p.slug] = row;
    }

    const leafRows = {};
    for (const slug of Object.keys(LEAF_META)) {
      const parentSlug = LEAF_TO_PARENT[slug];
      const meta = LEAF_META[slug];
      const row = await tx.productCategory.create({
        data: {
          organizationId: orgId,
          slug,
          name: meta.name,
          sortOrder: meta.sortOrder,
          parentId: parentRows[parentSlug].id,
        },
      });
      leafRows[slug] = row;
    }

    let n = 0;
    for (const item of CATALOG_ITEMS) {
      n += 1;
      const sku = `CS-${String(n).padStart(4, "0")}`;
      const cat = leafRows[item.cat];
      if (!cat) throw new Error(`Catégorie inconnue: ${item.cat}`);
      const unit = UNITS.has(item.unit) ? item.unit : "piece";
      const isActive = item.isActive !== false;
      await tx.product.create({
        data: {
          organizationId: orgId,
          categoryId: cat.id,
          sku,
          name: item.name,
          description: item.description || null,
          unit,
          basePriceHt: item.ht,
          vatRate: "20",
          isActive,
          minOrderQty: 1,
          stockQty: null,
          supplierUrl: item.supplierUrl || null,
          imageUrls: null,
        },
      });
    }
  });

  console.log(
    `  [${orgId.slice(0, 8)}…] Catalogue CLEAN SERVICES : ${CATALOG_ITEMS.length} produits, ${Object.keys(LEAF_META).length} sous-catégories.`
  );
}

async function main() {
  const orgIds = await resolveTargetOrgIds();
  for (const orgId of orgIds) {
    console.log("Organisation cible:", orgId);
    await seedOneOrganization(orgId);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
