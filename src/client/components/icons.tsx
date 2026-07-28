import { createElement, type ReactNode, type SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

const icon = (children: ReactNode) => function Icon({ size = 24, ...props }: IconProps) {
  return createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props }, children);
};

export const Flame = icon(<path d="M13.5 2.5c.5 3-1.4 4.3-2.8 6.1-1.1 1.4-.8 3.2.7 4.2-.2-2 1.2-3.1 2.5-4.2 2.1 1.8 3.6 4 3.6 6.6A5.5 5.5 0 0 1 6.5 15c0-4.8 3.7-7.7 7-12.5Z" />);
export const Plus = icon(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const X = icon(<><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>);
export const Check = icon(<path d="m5 12 4 4L19 6" />);
export const ChevronRight = icon(<path d="m9 18 6-6-6-6" />);
export const Menu = icon(<><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>);
export const MoreHorizontal = icon(<><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>);
export const Pause = icon(<><path d="M9 5v14" /><path d="M15 5v14" /></>);
export const Play = icon(<path d="m8 5 11 7-11 7Z" />);
export const ArrowUpRight = icon(<><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>);
export const ArrowDownRight = icon(<><path d="m7 7 10 10" /><path d="M17 7v10H7" /></>);
export const ExternalLink = icon(<><path d="M14 5h5v5" /><path d="m11 13 8-8" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>);
export const RotateCcw = icon(<><path d="M4 8V4m0 0h4" /><path d="M4.5 4.5A9 9 0 1 1 3 14" /></>);
export const LoaderCircle = icon(<><path d="M21 12a9 9 0 1 1-6.2-8.6" /><path d="M21 3v6h-6" /></>);
export const CircleDot = icon(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" fill="currentColor" /></>);
export const Gauge = icon(<><path d="M4 15a8 8 0 1 1 16 0" /><path d="m12 14 4-5" /><path d="M6 19h12" /></>);
export const BarChart3 = icon(<><path d="M5 20V10" /><path d="M12 20V4" /><path d="M19 20v-7" /></>);
export const Activity = icon(<path d="M3 12h4l2-7 4 14 2-7h6" />);
export const Zap = icon(<path d="m13 2-9 12h8l-1 8 9-12h-8Z" />);
export const Sparkles = icon(<><path d="m12 3 1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3Z" /><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8Z" /></>);
export const Bot = icon(<><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4" /><circle cx="9" cy="13" r="1" fill="currentColor" /><circle cx="15" cy="13" r="1" fill="currentColor" /><path d="M9 16h6" /></>);
export const Boxes = icon(<><path d="m12 2 7 4-7 4-7-4Z" /><path d="m5 10 7 4 7-4" /><path d="m5 14 7 4 7-4" /></>);
export const LayoutDashboard = icon(<><rect x="3" y="3" width="7" height="8" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="3" y="15" width="7" height="6" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /></>);
export const Settings = icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2" /></>);
export const Github = icon(<><circle cx="12" cy="12" r="9" /><path d="M8 20c0-2 0-3 2-3.5-3 0-4-1.5-4-4 0-1 .4-2 1.2-2.7-.2-.8-.2-1.8.3-2.6 1.4 0 2.4.8 3 1.2a10 10 0 0 1 3 0c.6-.4 1.6-1.2 3-1.2.5.8.5 1.8.3 2.6.8.7 1.2 1.7 1.2 2.7 0 2.5-1 4-4 4 2 .5 2 1.5 2 3.5" /></>);
export const GitPullRequest = icon(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M14 5h2a2 2 0 0 1 2 2v10" /><path d="m14 8-3-3 3-3" /></>);
export const LockKeyhole = icon(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" /></>);
export const ShieldCheck = icon(<><path d="M12 3 5 6v5c0 4.5 2.8 7.7 7 10 4.2-2.3 7-5.5 7-10V6Z" /><path d="m9 12 2 2 4-5" /></>);
export const Pencil = icon(<><path d="m4 20 4-1 11-11-3-3L5 16Z" /><path d="m14 7 3 3" /></>);
export const Trash2 = icon(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m7 7 1 14h8l1-14" /><path d="M10 11v6m4-6v6" /></>);
export const Clock3 = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>);
