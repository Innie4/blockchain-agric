import { NavLink } from "react-router-dom";
import type { Role } from "../../api/types";
import { useAuth } from "../../context/AuthContext";
import type { IconName } from "../ui/Icon";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Absent means every signed-in role sees it. */
  roles?: readonly Role[];
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/app/dashboard", label: "Dashboard", icon: "clipboard" },
  { to: "/app/products", label: "Products", icon: "package" },
  { to: "/app/products/register", label: "Register a batch", icon: "leaf", roles: ["FARMER"] },
  { to: "/app/transfers", label: "Transfers", icon: "truck" },
  { to: "/app/compliance", label: "Compliance", icon: "shield", roles: ["REGULATOR"] },
  { to: "/app/compliance/reports", label: "Reports", icon: "fileText", roles: ["REGULATOR"] },
  {
    to: "/app/operations/reconciliation",
    label: "Reconciliation",
    icon: "refresh",
    roles: ["REGULATOR"],
  },
  { to: "/app/activity", label: "Activity", icon: "flag" },
  { to: "/app/notifications", label: "Notifications", icon: "bell" },
  { to: "/app/profile", label: "Profile", icon: "user" },
  { to: "/app/settings", label: "Settings", icon: "clipboard" },
];

/**
 * Navigation for the signed-in area, narrowed to what the participant's role
 * can actually open. Hiding an action a role cannot take is a kindness, not a
 * security control: the server still refuses it, and the interface says so if
 * somebody arrives by a direct link.
 */
export function Nav() {
  const { user } = useAuth();
  const role: Role = user?.role ?? "CONSUMER";
  const items = NAV_ITEMS.filter(
    (item) => item.roles === undefined || item.roles.includes(role),
  );

  return (
    <nav className="app-nav" aria-label="Main">
      <ul className="app-nav__list">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink className="app-nav__link" to={item.to} end={item.to === "/app/dashboard"}>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
