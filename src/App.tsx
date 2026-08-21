import { Link, Outlet, useLocation } from "react-router-dom";
import AuthMenu from "./auth/AuthMenu";
import QueueDock from "./pages/ranked/QueueDock";
import { useServerClockSync } from "./time/useServerClock";

const NAV: [string, string][] = [
  ["/", "Versus"],
  ["/ranked", "Ranked"],
  ["/watch", "Watch"],
  ["/solo", "New Run"],
  ["/history", "History"],
];

export default function App() {
  useServerClockSync();
  const { pathname } = useLocation();
  const navLink = (to: string, label: string) => (
    <Link
      key={to}
      to={to}
      className={`plate relative flex shrink-0 items-center whitespace-nowrap py-2.5 text-sm tracking-widest transition sm:py-0 ${
        pathname === to ? "text-bone" : "text-slate-dim hover:text-slate-strong"
      }`}
    >
      {label}
      {pathname === to && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-transparent via-trophy to-transparent" />
      )}
    </Link>
  );
  return (
    <div className="min-h-screen">
      {/* Two rows on phones (brand + account, then the tab strip, which
          scrolls sideways if it must); one row from sm up. */}
      <header className="pt-safe border-b border-ink-700/60 bg-ink-950/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-stretch justify-between px-4 sm:flex-nowrap">
          <Link
            to="/"
            className="plate flex items-center py-3 text-xl font-bold tracking-wide text-bone"
          >
            El Copero <span className="mx-1 text-slate-dim">del</span> Dota
          </Link>
          <div className="order-2 flex items-center sm:order-3 sm:border-l sm:border-ink-700/60 sm:pl-4">
            <AuthMenu />
          </div>
          <nav
            aria-label="Sections"
            className="scrollbar-none order-3 -mx-4 flex w-[calc(100%+2rem)] gap-5 overflow-x-auto px-4 sm:order-2 sm:mx-0 sm:w-auto sm:gap-6 sm:overflow-visible sm:px-0"
          >
            {NAV.map(([to, label]) => navLink(to, label))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
      {/* Ranked matchmaking floats over every page, as in Dota. */}
      <QueueDock />
      <footer className="mx-auto max-w-6xl px-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] text-center text-xs text-slate-dim">
        El Copero del Dota — a fan-made Dota 2 drafting roguelite, inspired by 322-0.app · stats from
        Datdota · not affiliated with Valve. Team and player names are informational and remain the
        property of their owners.
      </footer>
    </div>
  );
}
