import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ProjectsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
    </Icon>
  );
}

export function CaptureIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="12.5" r="3.25" />
    </Icon>
  );
}

export function ViewerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" />
      <path d="M12 3.5V12l8-4M12 12v8.5M12 12 4 8" />
    </Icon>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 21 19H3z" />
      <path d="M12 10v4M12 16.5h.01" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function RetryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4h-4" />
    </Icon>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V5m0 0L8 9m4-4 4 4" />
      <path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15" />
    </Icon>
  );
}

export function OfflineIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 8.5A15.6 15.6 0 0 1 8 5.4M21.5 8.5a15.6 15.6 0 0 0-6.9-3.2M6 12.2a10.4 10.4 0 0 1 2.6-1.6M18 12.2a10.4 10.4 0 0 0-3.4-1.8M9.5 15.8a5.2 5.2 0 0 1 4.2.3" />
      <path d="M12 19h.01M3.5 3.5l17 17" />
    </Icon>
  );
}

/** Measure tools (WP 5.2) — a matched set at a glance in the tool switcher. */

export function DistanceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 19 19 5" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="5" r="2" />
    </Icon>
  );
}

export function PathIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 18 9 8l5 6 6-9" />
      <circle cx="4" cy="18" r="1.6" />
      <circle cx="14" cy="14" r="1.6" />
      <circle cx="20" cy="5" r="1.6" />
    </Icon>
  );
}

export function HeightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 19h18" />
      <path d="M12 17V5m0 0-3 3m3-3 3 3" />
      <circle cx="12" cy="4.5" r="1.4" />
    </Icon>
  );
}

export function AngleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 19h15M5 19 16 6" />
      <path d="M13 19a8 8 0 0 0-2-5.2" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 16v1.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V16" />
    </Icon>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12a8 8 0 1 1 2.4 5.7" />
      <path d="M4 4v4h4" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.1A1.5 1.5 0 0 0 8.8 19.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
    </Icon>
  );
}
