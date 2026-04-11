const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const IMAGE_BY_SKU = {
  "MEN-CHARIOT-001": "https://picsum.photos/seed/chariot-menage-compact/1200/900",
  "MEN-CHARIOT-002": "https://picsum.photos/seed/chariot-menage-2-seaux/1200/900",
  "MEN-CHARIOT-003": "https://picsum.photos/seed/chariot-menage-hotelier/1200/900",
  "MEN-PROD-001": "https://picsum.photos/seed/detergent-sol-5l/1200/900",
  "MEN-PROD-002": "https://picsum.photos/seed/desinfectant-surfaces-750ml/1200/900",
};

async function run() {
  const products = await prisma.product.findMany({
    where: { sku: { in: Object.keys(IMAGE_BY_SKU) } },
    select: { id: true, sku: true },
  });

  for (const product of products) {
    const imageUrl = IMAGE_BY_SKU[product.sku];
    await prisma.product.update({
      where: { id: product.id },
      data: { imageUrls: imageUrl },
    });
  }

  console.log(`Images mises à jour pour ${products.length} produit(s).`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
