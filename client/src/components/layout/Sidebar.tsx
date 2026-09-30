import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import type { Role } from "../../api/types";
import { useAuth } from "../../context/AuthContext";
import { isDemoDataEnabled } from "../../demo/mode";
import { Icon, type IconName } from "../ui/Icon";

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
  { to: "/app/settings", label: "Settings", icon: "settings" },
];

/**
 * The signed-in navigation, as a sidebar.
 *
 * A participant's role decides what they can act on, and this is the first place
 * that is visible. Hiding an action a role cannot take is a kindness, not a
 * security control: the server still refuses it, and the interface says so if
 * somebody arrives by a direct link.
 *
 * Each entry carries an icon as well as a label. The icon alone is never the
 * signal — a label always accompanies it, so nothing depends on recognising a
 * glyph.
 */
export function Sidebar({ open, onDismiss }: { open: boolean; onDismiss(): void }) {
  const { user } = useAuth();
  const role: Role = user?.role ?? "CONSUMER";
  // While fixture data is in use the whole navigation is shown, whatever the role.
  // The regulator's screens are a third of the product and are otherwise
  // unreachable, and a reviewer cannot review what the sidebar will not offer.
  const fixtures = isDemoDataEnabled();
  const items = fixtures
    ? NAV_ITEMS
    : NAV_ITEMS.filter((item) => item.roles === undefined || item.roles.includes(role));
  const panelRef = useRef<HTMLDivElement>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);

  // Opening the drawer moves focus into it, so a keyboard or screen reader user is
  // not left behind on the page underneath. Closing it hands focus back to
  // whatever opened it, which is why that element is remembered rather than
  // guessed at.
  useEffect(() => {
    if (open) {
      setReturnFocusTo(document.activeElement as HTMLElement | null);
      panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    } else if (returnFocusTo !== null) {
      returnFocusTo.focus();
      setReturnFocusTo(null);
    }
  }, [open, returnFocusTo]);

  // Escape closes the drawer. The sidebar is a navigation region rather than a
  // dialog, so it is not focus-trapped: tabbing past the last link should reach
  // the main content, not circle back round.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onDismiss]);

  return (
    <div
      ref={panelRef}
      id="app-sidebar"
      className={open ? "sidebar sidebar--open" : "sidebar"}
      data-open={open ? "true" : "false"}
    >
      <nav className="app-nav" aria-label="Main">
        <ul className="app-nav__list">
          {items.map((item) => (
            <li key={item.to} className="app-nav__item">
              <NavLink
                className="app-nav__link"
                to={item.to}
                end={item.to === "/app/dashboard"}
                onClick={onDismiss}
              >
                <Icon name={item.icon} size={18} className="app-nav__icon" />
                <span className="app-nav__label">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
