import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { ComponentType, SVGProps } from 'react';
import { CaptureIcon, ProjectsIcon, ViewerIcon } from './icons';

interface NavEntry {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Projects', Icon: ProjectsIcon },
  { to: '/capture', label: 'Capture', Icon: CaptureIcon },
  { to: '/viewer', label: 'Viewer', Icon: ViewerIcon },
];

function titleForPath(pathname: string): string {
  return NAV.find((entry) => entry.to === pathname)?.label ?? 'SplatScene';
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="size-7 rounded-md" />
      <span className="text-base font-semibold tracking-tight">SplatScene</span>
    </div>
  );
}

/**
 * Mobile-first layout: bottom tab bar below `md`, persistent sidebar at `md`
 * and above. The single `<main>` is the only scroll container the pages share.
 */
export function AppShell() {
  const { pathname } = useLocation();

  return (
    <div className="flex h-dvh w-full flex-col bg-surface text-content md:flex-row">
      {/* Sidebar — md and up */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-sunken px-3 py-4 md:flex">
        <div className="px-2 pb-5">
          <Brand />
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                [
                  'flex min-h-touch items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-raised text-content'
                    : 'text-muted hover:bg-raised/60 hover:text-content',
                ].join(' ')
              }
            >
              <Icon className="size-5 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto px-3 text-[11px] leading-relaxed text-muted">
          Milestone 0 · scaffold
          <br />
          Pipeline not yet connected.
        </p>
      </aside>

      {/* Mobile header */}
      <header className="safe-top flex h-14 shrink-0 items-center justify-between border-b border-line bg-sunken px-4 md:hidden">
        <Brand />
        <span className="text-sm text-muted">{titleForPath(pathname)}</span>
      </header>

      <main className="relative min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>

      {/* Bottom tab bar — below md */}
      <nav
        aria-label="Main"
        className="safe-bottom flex shrink-0 border-t border-line bg-sunken md:hidden"
      >
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              [
                'flex min-h-touch flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                isActive ? 'text-accent' : 'text-muted',
              ].join(' ')
            }
          >
            <Icon className="size-6" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default AppShell;
