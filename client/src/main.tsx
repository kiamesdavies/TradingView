import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Apply the default theme before the first paint; useBoot switches it once the saved layout arrives.
document.documentElement.dataset.theme ??= "dark";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// StrictMode is intentionally not used: its double-mounted effects would create and tear down
// lightweight-charts instances and series primitives twice in development.
createRoot(root).render(<App />);
