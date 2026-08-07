import { Link, Outlet, useLocation } from "react-router-dom";

export default function App() {
  const { pathname } = useLocation();
  const navLink = (to: string, label: string) => (
    <Link
      to={to}
      className={`plate text-sm tracking-widest ${
        pathname === to ? "text-bone" : "text-slate-dim hover:text-slate-strong"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-700/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="plate text-xl font-bold tracking-wide text-bone">
            El Copero <span className="text-slate-dim">del</span> Dota
          </Link>
          <nav className="flex gap-6">
            {navLink("/", "New Run")}
            {navLink("/mp", "Versus")}
            {navLink("/history", "History")}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-slate-dim">
        El Copero del Dota — a fan-made Dota 2 drafting roguelite, inspired by 322-0.app · stats from
        Datdota · not affiliated with Valve. Team and player names are informational and remain the
        property of their owners.
      </footer>
    </div>
  );
}
