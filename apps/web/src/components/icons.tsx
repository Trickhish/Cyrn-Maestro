/* The round-one mock drew navigation icons as empty 14px squares — placeholders
   meaning "an icon goes here", not a decision that the icons are blank. These
   fill them in, in the same monoline idiom: 14px box, 1.4 stroke, currentColor,
   no fills, so they inherit rail state (idle / hover / active) for free. */

type IconProps = { className?: string };

function Svg({ children, className }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`flex-none ${className ?? ""}`}
    >
      {children}
    </svg>
  );
}

/* Conductor: a baton stroke over two arcs — the logo's motif, reduced. */
export const ConductorIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 4.6a4.6 4.6 0 0 0 0 6.8" />
    <path d="M12.6 4.6a4.6 4.6 0 0 1 0 6.8" />
    <path d="M6.4 10.2 9.8 5.6" />
    <circle cx="6.1" cy="10.6" r="1.1" />
  </Svg>
);

export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 9.5h3l1 2h4l1-2h3" />
    <path d="M3.6 3.2h8.8l1.6 6.3v3H2V9.5z" />
  </Svg>
);

export const FleetIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.2" y="2.8" width="11.6" height="4" rx="1" />
    <rect x="2.2" y="9.2" width="11.6" height="4" rx="1" />
    <path d="M4.6 4.8h.01M4.6 11.2h.01" />
  </Svg>
);

export const ProvidersIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.4" cy="8" r="2.6" />
    <path d="M8 8h6" />
    <path d="M11.4 8v2.4M13.4 8v1.6" />
  </Svg>
);

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 4.8h11.2M2.4 11.2h11.2" />
    <circle cx="6" cy="4.8" r="1.6" />
    <circle cx="10.4" cy="11.2" r="1.6" />
  </Svg>
);

export const ThemeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3.4" />
    <path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
  </Svg>
);

/* Header actions on a task: pin the task, and open its history. */
export const PinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.6h4l-.6 3.4 2 2.2H4.6l2-2.2z" />
    <path d="M8 8.2v5.2" />
  </Svg>
);

export const HistoryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8" />
    <path d="M2.4 2.8v2.6h2.6" />
    <path d="M8 5.4V8l1.8 1.2" />
  </Svg>
);

export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.8 8h2.6l1.6-4.4 2.6 9L10.4 8h3.8" />
  </Svg>
);

export const ServerIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="2.6" width="11.2" height="4.2" rx="1" />
    <rect x="2.4" y="9.2" width="11.2" height="4.2" rx="1" />
    <path d="M4.8 4.7h.01M4.8 11.3h.01M11.4 4.7h1.2M11.4 11.3h1.2" />
  </Svg>
);

/* Two figures: the organization is its people before it is anything else. */
export const OrgIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="5.2" r="2.3" />
    <path d="M1.9 13.2c0-2.3 1.8-3.8 4.1-3.8s4.1 1.5 4.1 3.8" />
    <path d="M10.7 3.3a2.3 2.3 0 0 1 0 4.4M11.6 9.7c1.6.4 2.6 1.7 2.6 3.5" />
  </Svg>
);
