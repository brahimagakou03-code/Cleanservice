const { prisma } = require("../db");

function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function getPriceForCustomer(product, customerId) {
  const custom = await prisma.customerPriceList.findFirst({
    where: { productId: product.id, customerId },
    orderBy: [{ minQuantity: "desc" }, { createdAt: "desc" }],
  });
  if (custom) return Number(custom.customPrice);
  return Number(product.basePriceHt);
}

/**
 * Quand le prix catalogue (basePriceHt) change, aligne les tarifs portail (CustomerPriceList)
 * au même ratio qu’avant : un client au prix catalogue reste au catalogue ;
 * un client à −10 % reste à −10 % du nouveau prix.
 */
async function syncCustomerPriceListsAfterProductBaseChange(productId, oldBaseHt, newBaseHt) {
  const oldB = Number(oldBaseHt);
  const newB = Number(newBaseHt);
  if (Number.isNaN(oldB) || Number.isNaN(newB) || oldB === newB) return;

  const rows = await prisma.customerPriceList.findMany({ where: { productId } });
  if (!rows.length) return;

  if (oldB <= 0) {
    await prisma.customerPriceList.updateMany({
      where: { productId },
      data: { customPrice: newB },
    });
    return;
  }

  const ratio = newB / oldB;
  await prisma.$transaction(
    rows.map((row) =>
      prisma.customerPriceList.update({
        where: { id: row.id },
        data: { customPrice: roundMoney2(Number(row.customPrice) * ratio) },
      }),
    ),
  );
}

module.exports = { getPriceForCustomer, syncCustomerPriceListsAfterProductBaseChange };
