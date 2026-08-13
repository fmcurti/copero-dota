import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import Home from "./pages/Home";
import Draft from "./pages/Draft";
import History from "./pages/History";
import Versus from "./pages/mp/Versus";
import Room, { RankedRoom } from "./pages/mp/Room";
import Watch from "./pages/mp/Watch";
import Ranked from "./pages/ranked/Ranked";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          {/* Versus is the front door; solo lives at /solo. */}
          <Route path="/" element={<Versus />} />
          <Route path="/watch" element={<Watch />} />
          <Route path="/solo" element={<Home />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/history" element={<History />} />
          {/* Old shared links: /mp/:code room links must keep working. */}
          <Route path="/mp" element={<Navigate to="/" replace />} />
          <Route path="/mp/:code" element={<Room />} />
          <Route path="/ranked" element={<Ranked />} />
          <Route path="/ranked/:code" element={<RankedRoom />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
