const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { computeOrderTotals } = require("../src/utils/orders");
const { computeInvoiceTotals } = require("../src/utils/invoicing");
const { createSupabaseServiceClient } = require("../src/lib/supabase");
const { ensureStaffSupabaseAuthUser } = require("../src/utils/supabaseAuth");

const prisma = new PrismaClient();

async function createOrgWithUsers(orgData, users) {
  const { isPlatform, ...rest } = orgData;
  const org = await prisma.organization.create({
    data: { ...rest, isPlatform: isPlatform === true },
  });
  const svc = createSupabaseServiceClient();
  for (const user of users) {
    const emailNorm = String(user.email || "").trim().toLowerCase();
    let authUid = null;
    let passwordHash = null;
    if (svc) {
      const ensured = await ensureStaffSupabaseAuthUser(emailNorm, user.password);
      if (ensured.ok) {
        authUid = ensured.authUid;
      } else {
        console.warn(`[seed] Supabase Auth indisponible pour ${emailNorm}: ${ensured.error || "erreur"} — repli hash Prisma.`);
      }
    } else {
      console.warn("[seed] SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL absents — utilisateurs sans entrée Authentication (repli hash Prisma).");
    }
    if (!authUid) {
      passwordHash = await bcrypt.hash(user.password, 12);
    }
    await prisma.user.create({
      data: {
        email: emailNorm,
        passwordHash,
        authUid,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: org.id,
        isActive: true,
      },
    });
  }
  return org;
}

async function seedProducts(orgId) {
  const rootA = await prisma.productCategory.create({
    data: { organizationId: orgId, name: "Boissons", slug: "boissons", sortOrder: 1 },
  });
  const rootB = await prisma.productCategory.create({
    data: { organizationId: orgId, name: "Materiaux", slug: "materiaux", sortOrder: 2 },
  });
  const rootC = await prisma.productCategory.create({
    data: { organizationId: orgId, name: "Services", slug: "services", sortOrder: 3 },
  });
  const subs = await Promise.all([
    prisma.productCategory.create({ data: { organizationId: orgId, name: "Jus", slug: "jus", parentId: rootA.id, sortOrder: 1 } }),
    prisma.productCategory.create({ data: { organizationId: orgId, name: "Eaux", slug: "eaux", parentId: rootA.id, sortOrder: 2 } }),
    prisma.productCategory.create({ data: { organizationId: orgId, name: "Metaux", slug: "metaux", parentId: rootB.id, sortOrder: 1 } }),
    prisma.productCategory.create({ data: { organizationId: orgId, name: "Bois", slug: "bois", parentId: rootB.id, sortOrder: 2 } }),
    prisma.productCategory.create({ data: { organizationId: orgId, name: "Conseil", slug: "conseil", parentId: rootC.id, sortOrder: 1 } }),
  ]);
  const allCats = [rootA, rootB, rootC, ...subs];
  const units = ["piece", "kilogramme", "litre", "metre", "heure", "carton", "palette"];
  const vats = ["20", "10", "5.5", "2.1", "0"];
  for (let i = 1; i <= 15; i++) {
    const cat = allCats[i % allCats.length];
    await prisma.product.create({
      data: {
        organizationId: orgId,
        categoryId: cat.id,
        sku: `SKU-${String(i).padStart(5, "0")}`,
        name: `Produit ${i}`,
        description: `Description produit ${i}`,
        unit: units[i % units.length],
        basePriceHt: (5 + i * 1.7).toFixed(2),
        vatRate: vats[i % vats.length],
        isActive: i % 7 !== 0,
        minOrderQty: (i % 5) + 1,
        stockQty: i % 4 === 0 ? null : 10 + i,
        weightKg: (i / 2).toFixed(2),
        dimensions: `${10 + i}x${5 + i}x${2 + i}`,
        imageUrls: `https://picsum.photos/seed/${orgId}-${i}/600/400`,
      },
    });
  }
}

async function createCustomersForOrg(orgId, prefix, count) {
  for (let i = 1; i <= count; i++) {
    const code = `CLI-${String(i).padStart(4, "0")}`;
    const customer = await prisma.customer.create({
      data: {
        organizationId: orgId,
        code,
        companyName: `${prefix} Client ${i}`,
        countryCode: "FR",
        siret: `${String(10000000000000 + i)}`,
        vatNumber: `FR${String(1000000000 + i)}`,
        email: `client${i}@${prefix.toLowerCase()}.test`,
        phone: `06000000${String(i).padStart(2, "0")}`,
        website: `https://${prefix.toLowerCase()}-client-${i}.test`,
        notes: "Client seed CRM",
        paymentTerms: ["IMMEDIATE", "NET_15", "NET_30", "NET_45", "NET_60"][i % 5],
        isActive: i % 4 !== 0,
      },
    });

    const sitesCount = i % 2 === 0 ? 2 : 3;
    for (let s = 1; s <= sitesCount; s++) {
      await prisma.customerSite.create({
        data: {
          organizationId: orgId,
          customerId: customer.id,
          label: s === 1 ? "Siege" : `Entrepot ${s}`,
          fullAddress: `${s} Rue Example, 6900${s} Lyon`,
          isDefault: s === 1,
          isShipping: true,
          isBilling: s === 1,
          contactName: `Contact ${s}`,
          contactEmail: `contact${s}.${i}@${prefix.toLowerCase()}.test`,
          contactPhone: `07000000${s}${i}`,
        },
      });
    }
  }
}

async function main() {
  await prisma.payment.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.invoiceSequence.deleteMany();
  await prisma.orderStatusHistory.deleteMany();
  await prisma.orderLine.deleteMany();
  await prisma.customerPriceList.deleteMany();
  await prisma.customerSite.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.productCategory.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  await createOrgWithUsers(
    {
      name: "Clean Service (Siège)",
      slug: "clean-service-siege",
      siret: "00000000000001",
      address: "Siège — administration plateforme",
      phone: "0100000000",
      email: "siege@clean-service.test",
      logo: null,
      approvalThresholdTtc: "0",
      isPlatform: true,
    },
    [
      {
        email: "platform@clean.test",
        password: "Password123!",
        firstName: "Admin",
        lastName: "Plateforme",
        role: "PLATFORM_ADMIN",
      },
    ],
  );

  const alpha = await createOrgWithUsers(
    {
      name: "Alpha Services",
      slug: "alpha-services",
      siret: "12345678900011",
      address: "10 Rue de Paris, 75001 Paris",
      phone: "0102030405",
      email: "contact@alpha.test",
      logo: null,
      approvalThresholdTtc: "500",
    },
    [
      { email: "owner@alpha.test", password: "Password123!", firstName: "Alice", lastName: "Owner", role: "OWNER" },
      { email: "manager@alpha.test", password: "Password123!", firstName: "Marc", lastName: "Manager", role: "MANAGER" },
      { email: "viewer@alpha.test", password: "Password123!", firstName: "Val", lastName: "Viewer", role: "VIEWER" },
    ]
  );

  const beta = await createOrgWithUsers(
    {
      name: "Beta Commerce",
      slug: "beta-commerce",
      siret: "98765432100022",
      address: "22 Avenue de Lyon, 69002 Lyon",
      phone: "0607080910",
      email: "contact@beta.test",
      logo: null,
      approvalThresholdTtc: "800",
    },
    [
      { email: "owner@beta.test", password: "Password123!", firstName: "Benoit", lastName: "Owner", role: "OWNER" },
      { email: "admin@beta.test", password: "Password123!", firstName: "Amina", lastName: "Admin", role: "ADMIN" },
      { email: "member@beta.test", password: "Password123!", firstName: "Mehdi", lastName: "Member", role: "MEMBER" },
    ]
  );

  await seedProducts(alpha.id);
  await seedProducts(beta.id);
  await createCustomersForOrg(alpha.id, "Alpha", 5);
  await createCustomersForOrg(beta.id, "Beta", 5);

  const [alphaCustomers, betaCustomers, alphaProducts, betaProducts] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId: alpha.id }, take: 3 }),
    prisma.customer.findMany({ where: { organizationId: beta.id }, take: 3 }),
    prisma.product.findMany({ where: { organizationId: alpha.id }, take: 3 }),
    prisma.product.findMany({ where: { organizationId: beta.id }, take: 3 }),
  ]);
  const pairs = [
    [alphaCustomers[0], alphaProducts[0]],
    [alphaCustomers[1], alphaProducts[1]],
    [alphaCustomers[2], alphaProducts[2]],
    [betaCustomers[0], betaProducts[0]],
    [betaCustomers[1], betaProducts[1]],
  ];
  for (const [customer, product] of pairs) {
    await prisma.customerPriceList.create({
      data: {
        organizationId: customer.organizationId,
        customerId: customer.id,
        productId: product.id,
        customPrice: (Number(product.basePriceHt) * 0.9).toFixed(2),
        discountPercent: "10",
        minQuantity: 1,
      },
    });
  }

  const statuses = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "IN_PREPARATION", "SHIPPED", "DELIVERED", "CANCELLED"];
  const allUsers = await prisma.user.findMany();
  const usersByOrg = (orgId) => allUsers.filter((u) => u.organizationId === orgId);
  const allCustomers = await prisma.customer.findMany();
  const allSites = await prisma.customerSite.findMany();
  const allProducts = await prisma.product.findMany();

  async function seedOrdersForOrg(orgId, count, year = 2025) {
    const orgCustomers = allCustomers.filter((c) => c.organizationId === orgId);
    const orgProducts = allProducts.filter((p) => p.organizationId === orgId);
    const orgUsers = usersByOrg(orgId);
    for (let i = 1; i <= count; i++) {
      const customer = orgCustomers[(i - 1) % orgCustomers.length];
      const customerSites = allSites.filter((s) => s.customerId === customer.id);
      const delivery = customerSites.find((s) => s.isShipping) || customerSites[0];
      const billing = customerSites.find((s) => s.isBilling) || customerSites[0];
      const createdBy = orgUsers[(i - 1) % orgUsers.length];
      const status = statuses[(i - 1) % statuses.length];
      const lines = [0, 1, 2].map((idx) => {
        const product = orgProducts[(i + idx) % orgProducts.length];
        return {
          productId: product.id,
          productNameSnapshot: product.name,
          productSkuSnapshot: product.sku,
          quantity: Number((idx + 1) * 2),
          unitPriceHt: Number(product.basePriceHt),
          discountPercent: idx === 2 ? 5 : 0,
          vatRate: Number(product.vatRate),
        };
      });
      const totals = computeOrderTotals(lines);
      const number = `ORD-${year}-${String(i).padStart(4, "0")}`;
      const approvedBy = ["CONFIRMED", "IN_PREPARATION", "SHIPPED", "DELIVERED"].includes(status)
        ? orgUsers.find((u) => ["MANAGER", "ADMIN", "OWNER"].includes(u.role)) || createdBy
        : null;
      const order = await prisma.order.create({
        data: {
          organizationId: orgId,
          number,
          customerId: customer.id,
          deliverySiteId: delivery?.id || null,
          billingSiteId: billing?.id || null,
          status,
          totalHt: totals.totalHt.toFixed(2),
          totalTva: totals.totalTva.toFixed(2),
          totalTtc: totals.totalTtc.toFixed(2),
          notes: "Commande seed",
          internalNotes: "Interne seed",
          createdById: createdBy.id,
          approvedById: approvedBy?.id || null,
          approvedAt: approvedBy ? new Date() : null,
          requestedDeliveryDate: new Date(`${year}-12-15`),
          cancellationReason: status === "CANCELLED" ? "Annulee seed" : null,
        },
      });
      for (let j = 0; j < lines.length; j++) {
        const l = lines[j];
        const lineHt = l.quantity * l.unitPriceHt * (1 - l.discountPercent / 100);
        const lineTtc = lineHt * (1 + l.vatRate / 100);
        await prisma.orderLine.create({
          data: {
            organizationId: orgId,
            orderId: order.id,
            productId: l.productId,
            productNameSnapshot: l.productNameSnapshot,
            productSkuSnapshot: l.productSkuSnapshot,
            quantity: l.quantity.toString(),
            unitPriceHt: l.unitPriceHt.toFixed(2),
            discountPercent: l.discountPercent.toString(),
            vatRate: l.vatRate.toString(),
            lineTotalHt: lineHt.toFixed(2),
            lineTotalTtc: lineTtc.toFixed(2),
            sortOrder: j + 1,
          },
        });
      }
      await prisma.orderStatusHistory.create({
        data: {
          organizationId: orgId,
          orderId: order.id,
          fromStatus: null,
          toStatus: "DRAFT",
          changedById: createdBy.id,
          comment: "Creation",
        },
      });
      if (status !== "DRAFT") {
        const flow = ["PENDING_APPROVAL", "CONFIRMED", "IN_PREPARATION", "SHIPPED", "DELIVERED"];
        let current = "DRAFT";
        for (const s of flow) {
          if (s === status || (status === "CANCELLED" && s === "PENDING_APPROVAL")) {
            await prisma.orderStatusHistory.create({
              data: { organizationId: orgId, orderId: order.id, fromStatus: current, toStatus: s, changedById: (approvedBy || createdBy).id },
            });
            current = s;
            if (s === status) break;
          } else if (["CONFIRMED", "IN_PREPARATION", "SHIPPED", "DELIVERED"].includes(status) && flow.indexOf(s) < flow.indexOf(status)) {
            await prisma.orderStatusHistory.create({
              data: { organizationId: orgId, orderId: order.id, fromStatus: current, toStatus: s, changedById: (approvedBy || createdBy).id },
            });
            current = s;
          }
        }
        if (status === "CANCELLED") {
          await prisma.orderStatusHistory.create({
            data: { organizationId: orgId, orderId: order.id, fromStatus: "PENDING_APPROVAL", toStatus: "CANCELLED", changedById: (approvedBy || createdBy).id, comment: "Rejet seed" },
          });
        }
      }
    }
  }

  await seedOrdersForOrg(alpha.id, 10, 2025);
  await seedOrdersForOrg(beta.id, 10, 2025);

  async function seedInvoicesForOrg(orgId, count) {
    const customers = await prisma.customer.findMany({ where: { organizationId: orgId } });
    const orders = await prisma.order.findMany({ where: { organizationId: orgId }, include: { lines: true } });
    const statuses = ["DRAFT", "SENT", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED"];
    for (let i = 1; i <= count; i++) {
      const customer = customers[(i - 1) % customers.length];
      const order = orders[(i - 1) % orders.length];
      const type = i % 8 === 0 ? "PROFORMA" : "INVOICE";
      const status = statuses[(i - 1) % statuses.length];
      const lines = order.lines.slice(0, 2).map((l) => ({
        description: `${l.productSkuSnapshot} - ${l.productNameSnapshot}`,
        quantity: Number(l.quantity),
        unitPriceHt: Number(l.unitPriceHt),
        vatRate: Number(l.vatRate),
        discountPercent: Number(l.discountPercent),
      }));
      const totals = computeInvoiceTotals(lines);
      const issuedAt = new Date(`2025-0${(i % 9) + 1}-10`);
      const dueAt = new Date(issuedAt);
      dueAt.setDate(dueAt.getDate() + 30);
      const numberPrefix = type === "PROFORMA" ? "PRF" : "FAC";
      const invoice = await prisma.invoice.create({
        data: {
          organizationId: orgId,
          orderId: type === "INVOICE" ? order.id : null,
          customerId: customer.id,
          type,
          number: `${numberPrefix}-2025-${String(i).padStart(4, "0")}`,
          status,
          issuedAt: status === "DRAFT" ? null : issuedAt,
          dueAt,
          totalHt: totals.totalHt.toFixed(2),
          totalTva: totals.totalTva.toFixed(2),
          totalTtc: totals.totalTtc.toFixed(2),
          amountPaid: status === "PAID" ? totals.totalTtc.toFixed(2) : status === "PARTIALLY_PAID" ? (totals.totalTtc / 2).toFixed(2) : "0",
          amountDue: status === "PAID" ? "0" : status === "PARTIALLY_PAID" ? (totals.totalTtc / 2).toFixed(2) : totals.totalTtc.toFixed(2),
          legalMentions: "Penalites de retard: taux legal. Indemnite forfaitaire de recouvrement: 40 EUR.",
          sentAt: ["SENT", "PAID", "PARTIALLY_PAID", "OVERDUE"].includes(status) ? issuedAt : null,
          paidAt: status === "PAID" ? new Date(issuedAt.getTime() + 8 * 86400000) : null,
        },
      });
      for (let j = 0; j < lines.length; j++) {
        const l = lines[j];
        const lineTotals = computeInvoiceTotals([l]);
        await prisma.invoiceLine.create({
          data: {
            organizationId: orgId,
            invoiceId: invoice.id,
            description: l.description,
            quantity: l.quantity.toString(),
            unitPriceHt: l.unitPriceHt.toFixed(2),
            vatRate: l.vatRate.toString(),
            discountPercent: l.discountPercent.toString(),
            lineTotalHt: lineTotals.totalHt.toFixed(2),
            lineTotalTtc: lineTotals.totalTtc.toFixed(2),
            sortOrder: j + 1,
          },
        });
      }
    }
  }

  await seedInvoicesForOrg(alpha.id, 8);
  await seedInvoicesForOrg(beta.id, 7);

  const sentInvoices = await prisma.invoice.findMany({ where: { type: "INVOICE", status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE", "PAID"] } }, take: 5 });
  for (let i = 0; i < sentInvoices.length; i++) {
    const inv = sentInvoices[i];
    await prisma.payment.create({
      data: {
        organizationId: inv.organizationId,
        invoiceId: inv.id,
        amount: (Number(inv.totalTtc) / (i % 2 === 0 ? 1 : 2)).toFixed(2),
        paidAt: new Date(),
        method: ["virement", "cheque", "carte", "especes", "autre"][i % 5],
        reference: `PAY-${i + 1}`,
        notes: "Paiement seed",
      },
    });
  }

  const baseForCredit = await prisma.invoice.findMany({ where: { type: "INVOICE" }, take: 2, include: { lines: true } });
  for (let i = 0; i < baseForCredit.length; i++) {
    const inv = baseForCredit[i];
    const credit = await prisma.invoice.create({
      data: {
        organizationId: inv.organizationId,
        customerId: inv.customerId,
        type: "CREDIT_NOTE",
        number: `AVR-2025-${String(i + 1).padStart(4, "0")}`,
        status: "SENT",
        issuedAt: new Date(),
        dueAt: new Date(),
        originalInvoiceId: inv.id,
      },
    });
    for (let j = 0; j < inv.lines.length; j++) {
      const l = inv.lines[j];
      await prisma.invoiceLine.create({
        data: {
          organizationId: inv.organizationId,
          invoiceId: credit.id,
          description: l.description,
          quantity: (-Math.abs(Number(l.quantity))).toString(),
          unitPriceHt: Number(l.unitPriceHt).toFixed(2),
          vatRate: Number(l.vatRate).toString(),
          discountPercent: Number(l.discountPercent).toString(),
          lineTotalHt: (-Math.abs(Number(l.lineTotalHt))).toFixed(2),
          lineTotalTtc: (-Math.abs(Number(l.lineTotalTtc))).toFixed(2),
          sortOrder: j + 1,
        },
      });
    }
    const totalHt = inv.lines.reduce((a, l) => a - Math.abs(Number(l.lineTotalHt)), 0);
    const totalTtc = inv.lines.reduce((a, l) => a - Math.abs(Number(l.lineTotalTtc)), 0);
    await prisma.invoice.update({
      where: { id: credit.id },
      data: { totalHt: totalHt.toFixed(2), totalTva: (totalTtc - totalHt).toFixed(2), totalTtc: totalTtc.toFixed(2), amountDue: totalTtc.toFixed(2) },
    });
  }

  await prisma.platformBranding.upsert({
    where: { id: "site" },
    create: { id: "site" },
    update: {},
  });

  const customers = await prisma.customer.count();
  const products = await prisma.product.count();
  const orders = await prisma.order.count();
  const invoices = await prisma.invoice.count();
  const payments = await prisma.payment.count();
  console.log(
    `Seed termine: 3 organisations (1 siège + 2 franchisés), 7 utilisateurs, ${customers} clients CRM, ${products} produits catalogue, ${orders} commandes, ${invoices} factures, ${payments} paiements. Connexion siège : platform@clean.test (mot de passe seed commun : Password123!). Si Supabase est configure, chaque utilisateur seed a aussi une entree Authentication.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
