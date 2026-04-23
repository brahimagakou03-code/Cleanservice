-- Profils « admin boutique » : membres d’équipe rattachés à une organisation
-- franchisée (pas le siège), avec le rôle ADMIN (création typique depuis le siège).
--
-- Exécuter dans le SQL Editor Supabase ou psql sur la base liée à DATABASE_URL.

SELECT
  u.id,
  u.email,
  u."firstName"      AS prenom,
  u."lastName"       AS nom,
  u.role,
  u."isActive"       AS actif,
  u."authUid"        AS supabase_auth_uid,
  u."organizationId" AS organisation_id,
  o.name             AS boutique_nom,
  o.slug             AS boutique_slug
FROM "User" u
INNER JOIN "Organization" o ON o.id = u."organizationId"
WHERE o."isPlatform" = FALSE
  AND u.role = 'ADMIN'
ORDER BY o.name, u.email;

-- Variante : tous les rôles « gestion » boutique (hors siège), pas seulement ADMIN.
-- Décommenter pour utiliser à la place de la requête ci-dessus.
/*
SELECT
  u.id,
  u.email,
  u."firstName" AS prenom,
  u."lastName"  AS nom,
  u.role,
  u."isActive"  AS actif,
  u."authUid"   AS supabase_auth_uid,
  o.name        AS boutique_nom,
  o.slug        AS boutique_slug
FROM "User" u
INNER JOIN "Organization" o ON o.id = u."organizationId"
WHERE o."isPlatform" = FALSE
  AND u.role IN ('OWNER', 'ADMIN', 'MANAGER')
ORDER BY o.name, u.role, u.email;
*/
