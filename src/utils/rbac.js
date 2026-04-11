const Role = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
};

const abilities = {
  [Role.OWNER]: ["*"],
  [Role.ADMIN]: ["*", "!organization:delete"],
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
