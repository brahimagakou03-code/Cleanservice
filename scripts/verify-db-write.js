require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const dbInfo = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS db, current_user AS usr"
  );
  console.log("DB_OK", dbInfo);

  const suffix = Date.now().toString().slice(-8);
  const created = await prisma.organization.create({
    data: {
      name: "Test Connexion",
      slug: `test-conn-${suffix}`,
      siret: `${suffix}123456`,
      address: "Adresse test",
      phone: "0000000000",
      email: `test-${suffix}@example.com`,
    },
  });
  console.log("WRITE_OK", created.id);

  await prisma.organization.delete({ where: { id: created.id } });
  console.log("DELETE_OK");
}

main()
  .catch((error) => {
    console.error("TEST_FAIL", error.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
