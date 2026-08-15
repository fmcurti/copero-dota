import { Link, Outlet, useLocation } from "react-router-dom";
import AuthMenu from "./auth/AuthMenu";
import QueueDock from "./pages/ranked/QueueDock";

export default function App() {
  const { pathname } = useLocation();
  const navLink = (to: string, label: string) => (
    <Link
      to={to}
      className={`plate relative flex items-center text-sm tracking-widest transition ${
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
      <header className="border-b border-ink-700/60 bg-ink-950/60">
        <div className="mx-auto flex max-w-6xl items-stretch justify-between px-4">
          <Link to="/" className="plate flex items-center py-3 text-xl font-bold tracking-wide text-bone">
            El Copero <span className="mx-1 text-slate-dim">del</span> Dota
          </Link>
          <nav className="flex gap-6">
            {navLink("/", "Versus")}
            {navLink("/ranked", "Ranked")}
            {navLink("/watch", "Watch")}
            {navLink("/solo", "New Run")}
            {navLink("/history", "History")}
          </nav>
          <div className="flex items-center border-l border-ink-700/60 pl-4">
            <AuthMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
      {/* Ranked matchmaking floats over every page, as in Dota. */}
      <QueueDock />
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-slate-dim">
        El Copero del Dota — a fan-made Dota 2 drafting roguelite, inspired by 322-0.app · stats from
        Datdota · not affiliated with Valve. Team and player names are informational and remain the
        property of their owners.
      </footer>
    </div>
  );
}
