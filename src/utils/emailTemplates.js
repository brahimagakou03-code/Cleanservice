function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapHtml(title, body) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;">
    <h2>${title}</h2>
    <div>${body}</div>
    <hr />
    <p style="font-size:12px;color:#666;">Email automatique - Back Office</p>
  </div>`;
}

function teamInvitationTemplate({ firstName, inviteLink, tempPassword }) {
  const pwBlock =
    tempPassword != null && String(tempPassword).length > 0
      ? `<p><strong>Mot de passe provisoire :</strong> ${escHtml(tempPassword)}</p><p>Connectez-vous sur la page unique de connexion puis changez votre mot de passe dans Supabase (compte) si besoin.</p>`
      : "";
  return {
    subject: "Invitation equipe",
    html: wrapHtml(
      "Invitation equipe",
      `<p>Bonjour ${escHtml(firstName || "")}, vous etes invite(e) a rejoindre l'equipe.</p>${pwBlock}<p><a href="${escHtml(inviteLink)}">Se connecter</a></p>`
    ),
  };
}

function clientPortalInvitationTemplate({ customerName, portalLink }) {
  return {
    subject: "Invitation portail client",
    html: wrapHtml("Invitation portail client", `<p>${customerName}, votre acces portail est pret.</p><p><a href="${portalLink}">Acceder au portail</a></p>`),
  };
}

function clientPortalCredentialsTemplate({ customerName, loginUrl, identifier, plainPassword, code }) {
  const idLabel = String(identifier).includes("@") ? "Identifiant (votre e-mail)" : "Identifiant";
  const safeName = escHtml(customerName || "");
  const safeId = escHtml(identifier);
  const safePw = escHtml(plainPassword);
  const safeCode = escHtml(code);
  const safeUrl = escHtml(loginUrl);
  return {
    subject: "Vos acces portail client",
    html: wrapHtml(
      "Acces portail client",
      `<p>Bonjour ${safeName},</p>
      <p>Votre espace client est disponible. Conservez ce message precieusement.</p>
      <ul style="line-height:1.8;">
        <li><strong>${idLabel} :</strong> ${safeId}</li>
        <li><strong>Mot de passe provisoire :</strong> <code style="font-size:16px;background:#f0f0f0;padding:4px 8px;border-radius:4px;">${safePw}</code></li>
        <li><strong>Code client :</strong> ${safeCode} (pour reference)</li>
      </ul>
      <p>La connexion utilise Supabase : gardez ce mot de passe ou modifiez-le depuis votre compte (récupération de mot de passe sur la page de connexion).</p>
      <p><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#0f3f71;color:#fff;text-decoration:none;border-radius:8px;">Se connecter</a></p>`
    ),
  };
}

function invoiceSendTemplate({ invoiceNumber, amount, dueDate, pdfUrl }) {
  return {
    subject: `Facture ${invoiceNumber}`,
    html: wrapHtml("Envoi de facture", `<p>Votre facture <strong>${invoiceNumber}</strong> est disponible.</p><p>Montant: ${amount} EUR - Echeance: ${dueDate}</p><p><a href="${pdfUrl}">Telecharger le PDF</a></p>`),
  };
}

function invoiceReminderTemplate({ invoiceNumber, amountDue, dueDate, paymentLink }) {
  return {
    subject: `Relance facture ${invoiceNumber}`,
    html: wrapHtml("Relance de paiement", `<p>La facture ${invoiceNumber} est en retard.</p><p>Reste a payer: ${amountDue} EUR (echeance ${dueDate}).</p><p><a href="${paymentLink}">Regler maintenant</a></p>`),
  };
}

module.exports = {
  teamInvitationTemplate,
  clientPortalInvitationTemplate,
  clientPortalCredentialsTemplate,
  invoiceSendTemplate,
  invoiceReminderTemplate,
};
