const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const PRODUCTS = [
  {
    name: "Chariot de ménage compact",
    sku: "MEN-CHARIOT-001",
    description: "Chariot compact avec supports sacs et seaux pour l'entretien quotidien.",
    unit: "piece",
    basePriceHt: "249.00",
    vatRate: "20",
    minOrderQty: 1,
    stockQty: 25,
    dimensions: "85x55x105 cm",
  },
  {
    name: "Chariot de ménage professionnel 2 seaux",
    sku: "MEN-CHARIOT-002",
    description: "Chariot professionnel avec presse et double seau 2x25L.",
    unit: "piece",
    basePriceHt: "389.00",
    vatRate: "20",
    minOrderQty: 1,
    stockQty: 18,
    dimensions: "95x62x110 cm",
  },
  {
    name: "Chariot de ménage hôtelier",
    sku: "MEN-CHARIOT-003",
    description: "Chariot fermé pour hôtellerie avec rangement linge propre/sale.",
    unit: "piece",
    basePriceHt: "529.00",
    vatRate: "20",
    minOrderQty: 1,
    stockQty: 12,
    dimensions: "130x52x120 cm",
  },
  {
    name: "Détergent sol multi-usages 5L",
    sku: "MEN-PROD-001",
    description: "Nettoyant dégraissant pour sols carrelage et PVC.",
    unit: "litre",
    basePriceHt: "7.80",
    vatRate: "20",
    minOrderQty: 2,
    stockQty: 120,
  },
  {
    name: "Désinfectant surfaces 750ml",
    sku: "MEN-PROD-002",
    description: "Spray désinfectant prêt à l'emploi pour plans de travail.",
    unit: "piece",
    basePriceHt: "4.90",
    vatRate: "20",
    minOrderQty: 6,
    stockQty: 200,
  },
];

async function run() {
  const organizations = await prisma.organization.findMany({
    select: { id: true, name: true },
  });

  for (const org of organizations) {
    const category = await prisma.productCategory.upsert({
      where: {
        organizationId_slug: {
          organizationId: org.id,
          slug: "materiel-menage",
        },
      },
      update: {
        name: "Matériel de ménage",
        description: "Produits et chariots de ménage",
      },
      create: {
        organizationId: org.id,
        name: "Matériel de ménage",
        slug: "materiel-menage",
        description: "Produits et chariots de ménage",
        sortOrder: 50,
      },
    });

    for (const product of PRODUCTS) {
      await prisma.product.upsert({
        where: {
          organizationId_sku: {
            organizationId: org.id,
            sku: product.sku,
          },
        },
        update: {
          name: product.name,
          description: product.description,
          unit: product.unit,
          basePriceHt: product.basePriceHt,
          vatRate: product.vatRate,
          minOrderQty: product.minOrderQty,
          stockQty: product.stockQty,
          dimensions: product.dimensions || null,
          isActive: true,
          categoryId: category.id,
        },
        create: {
          organizationId: org.id,
          categoryId: category.id,
          name: product.name,
          sku: product.sku,
          description: product.description,
          unit: product.unit,
          basePriceHt: product.basePriceHt,
          vatRate: product.vatRate,
          minOrderQty: product.minOrderQty,
          stockQty: product.stockQty,
          dimensions: product.dimensions || null,
          isActive: true,
        },
      });
    }
  }

  console.log(`Produits de ménage ajoutés pour ${organizations.length} organisation(s).`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
