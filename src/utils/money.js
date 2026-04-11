/** Conversion sûre Prisma Decimal / string / number pour l’affichage admin. */
function toFiniteNumber(value) {
  if (value == null || value === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** Affichage catalogue / tableaux (fr-FR). */
function formatEuroHtDisplay(value) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Valeur pour attribut <input type="number"> */
function formatEuroHtInput(value) {
  const n = toFiniteNumber(value);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/** TTC à partir du HT et du taux TVA (chaîne "20", "5.5", …). */
function priceTtcFromHt(htValue, vatRateStr) {
  const ht = toFiniteNumber(htValue);
  const vat = Number(vatRateStr);
  if (!Number.isFinite(ht) || !Number.isFinite(vat)) return NaN;
  return ht * (1 + vat / 100);
}

function formatEuroTtcDisplay(htValue, vatRateStr) {
  const ttc = priceTtcFromHt(htValue, vatRateStr);
  if (!Number.isFinite(ttc)) return "—";
  return ttc.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = {
  toFiniteNumber,
  formatEuroHtDisplay,
  formatEuroHtInput,
  priceTtcFromHt,
  formatEuroTtcDisplay,
};
