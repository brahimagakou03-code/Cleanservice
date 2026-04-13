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

function teamInvitationTemplate({ firstName, inviteLink, supabaseInviteSent, existingSupabaseAccount }) {
  const safeFirst = escHtml(firstName || "");
  const safeLink = escHtml(inviteLink);

  if (existingSupabaseAccount) {
    return {
      subject: "Invitation equipe Clean Service",
      html: wrapHtml(
        "Invitation equipe",
        `<p>Bonjour ${safeFirst},</p>
        <p>Vous avez ete ajoute(e) a l'equipe. Un compte existe deja pour cette adresse e-mail.</p>
        <p><a href="${safeLink}">Ouvrir la page de connexion</a> — si besoin, utilisez la fonction « Mot de passe oublie » pour en definir un nouveau.</p>`
      ),
    };
  }

  if (supabaseInviteSent) {
    return {
      subject: "Invitation equipe Clean Service",
      html: wrapHtml(
        "Invitation equipe",
        `<p>Bonjour ${safeFirst},</p>
        <p>Vous avez ete invite(e) a rejoindre l'equipe sur Clean Service.</p>
        <p><strong>Ouvrez l'e-mail d'invitation</strong> envoye par le systeme d'authentification (lien pour definir votre mot de passe), puis connectez-vous ici : <a href="${safeLink}">${safeLink}</a></p>
        <p>Ce message est un rappel complementaire ; le lien principal se trouve dans l'autre message.</p>`
      ),
    };
  }

  return {
    subject: "Invitation equipe Clean Service",
    html: wrapHtml(
      "Invitation equipe",
      `<p>Bonjour ${safeFirst}, vous etes invite(e) a rejoindre l'equipe.</p><p><a href="${safeLink}">Se connecter</a></p>`
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
