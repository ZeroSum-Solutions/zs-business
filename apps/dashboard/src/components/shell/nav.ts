import { CalendarBlank, ChatsCircle, House, Browser, Robot, UsersThree, type Icon } from "@phosphor-icons/react";

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

/** The six areas. Settings, Connections and Plan live under the account menu. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/inbox", label: "Inbox", icon: ChatsCircle },
  { href: "/calendar", label: "Calendar", icon: CalendarBlank },
  { href: "/customers", label: "Customers", icon: UsersThree },
  { href: "/site", label: "Site", icon: Browser },
  { href: "/agents", label: "Agents", icon: Robot },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
