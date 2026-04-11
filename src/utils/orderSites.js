/**
 * Sites facturation / livraison : liens commande, sinon sites du client (fiche).
 */
function resolvePurchaseOrderSites(order) {
  const sites = order.customer?.sites || [];
  let billing = order.billingSite;
  let delivery = order.deliverySite;

  if (!billing && sites.length) {
    billing = sites.find((s) => s.isBilling) || sites.find((s) => s.isDefault) || sites[0];
  }
  if (!delivery && sites.length) {
    delivery = sites.find((s) => s.isShipping) || sites.find((s) => s.isDefault) || sites[0];
  }
  if (!delivery && billing) delivery = billing;
  if (!billing && delivery) billing = delivery;

  return { billingSite: billing || null, deliverySite: delivery || null };
}

module.exports = { resolvePurchaseOrderSites };
