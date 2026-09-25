// Small inline SVG icon set (stroke = currentColor) so the shell has no icon-font dependency.
import type { ReactElement, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number, props: SVGProps<SVGSVGElement>, children: ReactElement | ReactElement[]): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = ({ size = 16, ...p }: IconProps) =>
  base(size, p, [<circle key="c" cx="11" cy="11" r="6.5" />, <path key="l" d="m20 20-4.2-4.2" />]);
export const GearIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, [
    <circle key="c" cx="12" cy="12" r="3" />,
    <path
      key="p"
      d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
    />,
  ]);
export const SunIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, [
    <circle key="c" cx="12" cy="12" r="4" />,
    <path key="r" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
  ]);
export const MoonIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />);
export const IndicatorsIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, [<path key="a" d="M3 17l5-6 4 4 8-9" />, <path key="b" d="M3 21h18" />]);
export const PlusIcon = ({ size = 16, ...p }: IconProps) => base(size, p, <path d="M12 5v14M5 12h14" />);
export const CloseIcon = ({ size = 14, ...p }: IconProps) => base(size, p, <path d="M6 6l12 12M18 6 6 18" />);
export const PencilIcon = ({ size = 14, ...p }: IconProps) =>
  base(size, p, <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />);
export const TrashIcon = ({ size = 14, ...p }: IconProps) =>
  base(size, p, [<path key="a" d="M4 7h16M10 11v6M14 11v6" />, <path key="b" d="M6 7l1 13h10l1-13M9 7V4h6v3" />]);
export const ListIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />);
export const BellIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, [<path key="a" d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z" />, <path key="b" d="M10 21h4" />]);
export const PanelIcon = ({ size = 18, ...p }: IconProps) =>
  base(size, p, [<rect key="a" x="3" y="4" width="18" height="16" rx="2" />, <path key="b" d="M15 4v16" />]);
export const GripIcon = ({ size = 12, ...p }: IconProps) =>
  base(size, p, <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={3} />);
export const ChevronIcon = ({ size = 12, ...p }: IconProps) => base(size, p, <path d="m6 9 6 6 6-6" />);
