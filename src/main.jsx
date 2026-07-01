import React from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Root from "./App.jsx";
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
