import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import Home from "./pages/Home";
import Draft from "./pages/Draft";
import History from "./pages/History";
import Versus from "./pages/mp/Versus";
import Room from "./pages/mp/Room";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Home />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/history" element={<History />} />
          <Route path="/mp" element={<Versus />} />
          <Route path="/mp/:code" element={<Room />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
