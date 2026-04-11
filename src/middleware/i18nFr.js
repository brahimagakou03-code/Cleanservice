const ORDER_STATUS = {
  DRAFT: "Brouillon",
  PENDING_APPROVAL: "En attente d'approbation",
  CONFIRMED: "Confirmée",
  IN_PREPARATION: "En préparation",
  SHIPPED: "Expédiée",
  DELIVERED: "Livrée",
  CANCELLED: "Annulée",
};

const INVOICE_STATUS = {
  DRAFT: "Brouillon",
  SENT: "Envoyée",
  PAID: "Payée",
  PARTIALLY_PAID: "Partiellement payée",
  OVERDUE: "En retard",
  CANCELLED: "Annulée",
};

const INVOICE_TYPE = {
  INVOICE: "Facture",
  CREDIT_NOTE: "Avoir",
  PROFORMA: "Pro forma",
};

const ROLE = {
  OWNER: "Administrateur",
  ADMIN: "Co-administrateur",
  MANAGER: "Gestionnaire",
  MEMBER: "Membre",
  VIEWER: "Lecteur",
};

const PAYMENT_TERMS = {
  IMMEDIATE: "Immédiat",
  NET_15: "15 jours",
  NET_30: "30 jours",
  NET_45: "45 jours",
  NET_60: "60 jours",
};

function i18nFr(_req, res, next) {
  res.locals.fr = {
    orderStatus: (v) => ORDER_STATUS[v] || v,
    invoiceStatus: (v) => INVOICE_STATUS[v] || v,
    invoiceType: (v) => INVOICE_TYPE[v] || v,
    role: (v) => ROLE[v] || v,
    paymentTerms: (v) => PAYMENT_TERMS[v] || v,
  };
  next();
}

/** Libellés FR pour usage côté serveur (ex. graphiques). */
function orderStatusLabel(v) {
  return ORDER_STATUS[v] || v;
}

module.exports = { i18nFr, orderStatusLabel };
