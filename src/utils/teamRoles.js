const { Role, can } = require("./rbac");

/** Rôles métier assignables dans une organisation franchisée (jamais PLATFORM_ADMIN). */
function getAssignableTenantRoles(actorRole) {
  const all = [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.MEMBER, Role.VIEWER];
  if (actorRole === Role.OWNER) return all;
  if (actorRole === Role.ADMIN) return all.filter((r) => r !== Role.OWNER);
  return [];
}

function canInviteTenantMembers(actorRole) {
  return can(actorRole, "team:manage");
}

/** Rôles pour l’équipe siège Clean Service (organisation isPlatform). */
function getAssignablePlatformRoles() {
  return [Role.PLATFORM_ADMIN];
}

function actorCanSetTenantRole(actorRole, targetRole) {
  if (!getAssignableTenantRoles(actorRole).includes(targetRole)) return false;
  if (targetRole === Role.OWNER && !can(actorRole, "team:assign-owner")) return false;
  return true;
}

module.exports = {
  getAssignableTenantRoles,
  getAssignablePlatformRoles,
  canInviteTenantMembers,
  actorCanSetTenantRole,
};
