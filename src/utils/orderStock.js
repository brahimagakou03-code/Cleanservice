/**
 * Stock : réservation à la confirmation, décrément physique à l’expédition, libération / réintégration à l’annulation.
 * Produit avec stockQty null = pas de suivi (pas de réservation ni décrément).
 */

const S = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  CONFIRMED: "CONFIRMED",
  IN_PREPARATION: "IN_PREPARATION",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
};

function lineQtyInt(line) {
  return Math.max(0, Math.floor(Number(line.quantity || 0)));
}

async function sumReservedForProduct(tx, organizationId, productId) {
  const agg = await tx.orderLineStockReservation.aggregate({
    where: { organizationId, productId },
    _sum: { quantity: true },
  });
  return Number(agg._sum.quantity || 0);
}

/** Quantité encore disponible à la vente (physique − réservations actives). null si stock non suivi. */
async function availableAfterReservations(tx, organizationId, product) {
  if (product.stockQty == null) return null;
  const reserved = await sumReservedForProduct(tx, organizationId, product.id);
  return Number(product.stockQty) - reserved;
}

/**
 * Vérifie qu’on peut passer commande portail (sans réserver : réservation seulement à la confirmation).
 * @returns {Promise<string|null>} message d’erreur ou null si ok
 */
async function assertPortalCartStockAvailable(prisma, organizationId, lines) {
  for (const l of lines) {
    if (!l.productId) continue;
    const product = await prisma.product.findFirst({
      where: { id: l.productId, organizationId },
    });
    if (!product || product.stockQty == null) continue;
    const qty = lineQtyInt({ quantity: l.quantity });
    if (qty <= 0) continue;
    const avail = await availableAfterReservations(prisma, organizationId, product);
    if (avail < qty) {
      return `Stock insuffisant pour « ${product.name} » (${product.sku}) : ${Math.max(0, avail)} unité(s) disponible(s), ${qty} demandée(s).`;
    }
  }
  return null;
}

async function reserveStocksForOrderTx(tx, orderId, organizationId) {
  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    include: { lines: { include: { product: true } } },
  });
  if (!order) throw new Error("Commande introuvable");

  for (const line of order.lines) {
    if (!line.productId || !line.product) continue;
    const product = line.product;
    if (product.stockQty == null) continue;
    const qty = lineQtyInt(line);
    if (qty <= 0) continue;

    const existing = await tx.orderLineStockReservation.findUnique({ where: { orderLineId: line.id } });
    if (existing) continue;

    const avail = await availableAfterReservations(tx, organizationId, product);
    if (avail < qty) {
      throw new Error(
        `Stock insuffisant pour « ${product.name} » (${product.sku}) : ${Math.max(0, avail)} disponible(s), ${qty} demandée(s).`,
      );
    }

    await tx.orderLineStockReservation.create({
      data: {
        organizationId,
        orderId: order.id,
        orderLineId: line.id,
        productId: product.id,
        quantity: qty,
      },
    });
  }
}

async function releaseReservationsForOrderTx(tx, orderId, organizationId) {
  await tx.orderLineStockReservation.deleteMany({ where: { orderId, organizationId } });
}

async function deductStocksOnShipTx(tx, orderId, organizationId) {
  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    include: { lines: true },
  });
  if (!order) throw new Error("Commande introuvable");

  for (const line of order.lines) {
    if (!line.productId) continue;
    const product = await tx.product.findFirst({ where: { id: line.productId, organizationId } });
    if (!product || product.stockQty == null) continue;

    const qty = lineQtyInt(line);
    if (qty <= 0) continue;

    const res = await tx.orderLineStockReservation.findUnique({ where: { orderLineId: line.id } });
    const dec = res ? res.quantity : qty;

    if (res) {
      await tx.orderLineStockReservation.delete({ where: { id: res.id } });
    }

    const current = Number(product.stockQty);
    const next = Math.max(0, current - dec);
    await tx.product.update({ where: { id: product.id }, data: { stockQty: next } });
  }
}

/** Après expédition/livraison : annulation = réintègre le stock physique (les réservations sont déjà levées). */
async function restoreStocksAfterShippedCancelTx(tx, orderId, organizationId) {
  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    include: { lines: true },
  });
  if (!order) return;

  for (const line of order.lines) {
    if (!line.productId) continue;
    const product = await tx.product.findFirst({ where: { id: line.productId, organizationId } });
    if (!product || product.stockQty == null) continue;
    const qty = lineQtyInt(line);
    if (qty <= 0) continue;
    await tx.product.update({
      where: { id: product.id },
      data: { stockQty: Number(product.stockQty) + qty },
    });
  }
}

/**
 * À appeler dans la même transaction que la mise à jour du statut commande.
 */
async function applyStockOnStatusTransitionTx(tx, { organizationId, orderId, fromStatus, toStatus }) {
  if (toStatus === S.CONFIRMED && [S.DRAFT, S.PENDING_APPROVAL].includes(fromStatus)) {
    await reserveStocksForOrderTx(tx, orderId, organizationId);
  }

  if (toStatus === S.SHIPPED && fromStatus === S.IN_PREPARATION) {
    await deductStocksOnShipTx(tx, orderId, organizationId);
  }

  if (toStatus === S.CANCELLED) {
    await releaseReservationsForOrderTx(tx, orderId, organizationId);
    if ([S.SHIPPED, S.DELIVERED].includes(fromStatus)) {
      await restoreStocksAfterShippedCancelTx(tx, orderId, organizationId);
    }
  }
}

module.exports = {
  applyStockOnStatusTransitionTx,
  assertPortalCartStockAvailable,
  reserveStocksForOrderTx,
};
