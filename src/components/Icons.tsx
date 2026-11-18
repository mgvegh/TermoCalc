type IconProps = { className?: string }

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
}

export const CopyIcon = ({ className = 'h-4 w-4' }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

export const CheckIcon = ({ className = 'h-4 w-4' }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const AlertIcon = ({ className = 'h-5 w-5' }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
)

export const SwapIcon = ({ className = 'h-4 w-4' }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m7 16-4-4 4-4M3 12h18M17 8l4 4-4 4" transform="rotate(90 12 12)" />
  </svg>
)

export const ChevronIcon = ({ className = 'h-4 w-4' }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const ThermoIcon = ({ className = 'h-6 w-6' }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />
  </svg>
)
