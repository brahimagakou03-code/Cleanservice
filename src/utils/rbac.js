const Role = {
  /** Siège Clean Service uniquement (organisation `isPlatform`). */
  PLATFORM_ADMIN: "PLATFORM_ADMIN",
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
};

const abilities = {
  [Role.PLATFORM_ADMIN]: ["platform:read", "platform:orgs:view", "team:manage"],
  [Role.OWNER]: ["*", "!organization:delete"],
  [Role.ADMIN]: ["*", "!organization:delete", "!team:assign-owner"],
  [Role.MANAGER]: ["clients:manage", "products:manage", "orders:manage", "orders:view"],
  [Role.MEMBER]: ["orders:create", "orders:view:own"],
  [Role.VIEWER]: ["read:all"],
};

function can(role, permission) {
  const roleAbilities = abilities[role] || [];
  if (roleAbilities.includes("*")) {
    return !roleAbilities.includes(`!${permission}`);
  }
  return roleAbilities.includes(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !can(req.user.role, permission)) {
      return res.status(403).send("Acces refuse");
    }
    return next();
  };
}

module.exports = { Role, can, requirePermission };
