import type { SVGProps } from "react";

/**
 * The small inline icon set used across the interface.
 *
 * Icons are decoration: they are always `aria-hidden` and never carry meaning on
 * their own. Where an icon is the only signal, a text label accompanies it.
 */

export type IconName =
  | "alertTriangle"
  | "bell"
  | "check"
  | "chevronRight"
  | "clipboard"
  | "download"
  | "externalLink"
  | "fileText"
  | "flag"
  | "info"
  | "leaf"
  | "link"
  | "package"
  | "qr"
  | "refresh"
  | "search"
  | "shield"
  | "store"
  | "truck"
  | "user"
  | "warning"
  | "x";

const PATHS: Record<IconName, string> = {
  alertTriangle:
    "M12 4.5 3 19.5h18L12 4.5Zm0 5.5v4.5m0 3v.01",
  bell: "M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Zm4.5 9a1.5 1.5 0 0 0 3 0",
  check: "M5 12.5 9.5 17 19 7.5",
  chevronRight: "M9.5 5.5 16 12l-6.5 6.5",
  clipboard:
    "M9 4.5h6M9 4.5a1.5 1.5 0 0 0-1.5 1.5H6A1.5 1.5 0 0 0 4.5 7.5v12A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 18 6h-1.5A1.5 1.5 0 0 0 15 4.5M8.5 11h7m-7 4h7m-7 4h4",
  download: "M12 4v10m0 0 4-4m-4 4-4-4M4.5 18.5h15",
  externalLink: "M14 4.5h5.5V10M19 5 11 13M17 14v4.5A1.5 1.5 0 0 1 15.5 20h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10",
  fileText: "M6 3.5h7l5 5v12H6v-17Zm7 0v5h5M9 13h6m-6 3.5h6",
  flag: "M6 21V4m0 0h11l-2 4 2 4H6",
  info: "M12 4.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm0 3.5v.01M12 11v5",
  leaf: "M20 4c0 9-5.5 12-11 12a5 5 0 0 1 0-10c3 0 4.5-1 5.5-2.5C16 4 20 4 20 4Zm0 0C11 6 6 10 6 15.5",
  link: "M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1 1m-2 3a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1-1",
  package: "M12 3.5 3.5 8v8L12 20.5 20.5 16V8L12 3.5Zm0 0V12m0 0 8.5-4M12 12 3.5 8M7.5 10.25v5.5",
  qr: "M4.5 4.5h6v6h-6v-6Zm9 0h6v6h-6v-6Zm-9 9h6v6h-6v-6Zm10 0h1.5m3 0h1.5m-6 2.5h1.5m3 0h1.5m-6 3h1.5m3 0h1.5",
  refresh: "M20 12a8 8 0 1 1-2.5-5.8M20 4v4.5h-4.5",
  search: "M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm4.75 11.25L20 20",
  shield: "M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6l-7-2.5Zm-2.5 8.5L11.5 14l4-4",
  store: "M4 9.5h16M4 9.5 5.5 4.5h13L20 9.5M4 9.5v10h16v-10M9.5 19.5v-5h5v5",
  truck: "M2.5 6.5h11v10h-11v-10Zm11 3.5h4l3 3.5v3h-7v-6.5ZM7 20a1.75 1.75 0 1 0 0-3.5A1.75 1.75 0 0 0 7 20Zm11 0a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z",
  user: "M12 4.5a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5ZM4.5 20.5c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5",
  warning: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm0 4v5m0 3v.01",
  x: "M6 6l12 12M18 6 6 18",
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Rendered width and height in pixels. */
  size?: number;
  strokeWidth?: number;
}

/**
 * A single-path icon. Kept to one path per glyph so the set stays consistent in
 * weight and alignment without a drawing tool in the build.
 */
export function Icon({ name, size = 18, strokeWidth = 1.5, ...rest }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
