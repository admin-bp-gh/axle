// register-user.js — usage: node register-user.js <tailscale_login> <display_name> [role]
const { db, audit } = require("./db.js");
const [login, name, role] = process.argv.slice(2);
if (!login || !name) {
  console.log("usage: node register-user.js <tailscale_login> <display_name> [sales|admin]");
  process.exit(1);
}
db.prepare(
  "INSERT OR REPLACE INTO users (tailscale_login, display_name, role) VALUES (?, ?, ?)"
).run(login, name, role || "sales");
audit("system", "register_user", null, `${login} as ${name} (${role || "sales"})`);
console.log("Registered:", login, "as", role || "sales");
