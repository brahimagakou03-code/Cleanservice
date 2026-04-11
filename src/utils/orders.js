const { can } = require("./rbac");

const STATUS = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  CONFIRMED: "CONFIRMED",
  IN_PREPARATION: "IN_PREPARATION",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
};

function computeLineTotals({ quantity, unitPriceHt, discountPercent, vatRate }) {
  const qty = Number(quantity || 0);
  const unit = Number(unitPriceHt || 0);
  const discount = Number(discountPercent || 0) / 100;
  const vat = Number(vatRate || 0) / 100;
  const lineHt = qty * unit * (1 - discount);
  const lineTtc = lineHt * (1 + vat);
  return { lineHt, lineTtc };
}

function computeOrderTotals(lines) {
  let totalHt = 0;
  let totalTtc = 0;
  for (const l of lines) {
    const { lineHt, lineTtc } = computeLineTotals(l);
    totalHt += lineHt;
    totalTtc += lineTtc;
  }
  return { totalHt, totalTtc, totalTva: totalTtc - totalHt };
}

async function nextOrderNumber(prisma, organizationId, date = new Date()) {
  const year = date.getFullYear();
  const prefix = `ORD-${year}-`;
  const last = await prisma.order.findFirst({
    where: { organizationId, number: { startsWith: prefix } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const n = last?.number ? Number(last.number.split("-")[2]) : 0;
  return `${prefix}${String((n || 0) + 1).padStart(4, "0")}`;
}

function canApprove(role) {
  return ["MANAGER", "ADMIN", "OWNER"].includes(role);
}

function availableActions(order, userRole) {
  const actions = [];
  if (order.status === STATUS.DRAFT) actions.push("edit", "confirm", "delete", "cancel");
  if (order.status === STATUS.PENDING_APPROVAL && canApprove(userRole)) actions.push("approve", "reject", "cancel");
  if (order.status === STATUS.CONFIRMED) actions.push("prepare", "cancel");
  if (order.status === STATUS.IN_PREPARATION) actions.push("ship", "cancel");
  if (order.status === STATUS.SHIPPED) actions.push("deliver", "cancel");
  if (order.status === STATUS.DELIVERED && !order.isInvoiced) actions.push("generate_invoice");
  actions.push("duplicate");
  return actions;
}

function canStatusTransition({ from, to, role }) {
  if (from === STATUS.DRAFT && [STATUS.CONFIRMED, STATUS.PENDING_APPROVAL, STATUS.CANCELLED].includes(to)) return true;
  if (from === STATUS.PENDING_APPROVAL && [STATUS.CONFIRMED, STATUS.CANCELLED].includes(to)) return canApprove(role);
  if (from === STATUS.CONFIRMED && to === STATUS.IN_PREPARATION) return true;
  if (from === STATUS.IN_PREPARATION && to === STATUS.SHIPPED) return true;
  if (from === STATUS.SHIPPED && to === STATUS.DELIVERED) return true;
  if (![STATUS.CANCELLED, STATUS.DELIVERED].includes(from) && to === STATUS.CANCELLED) return true;
  return false;
}

module.exports = { STATUS, computeLineTotals, computeOrderTotals, nextOrderNumber, availableActions, canStatusTransition, canApprove };
