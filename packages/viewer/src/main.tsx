import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadBundle, readLaunchParams } from "./data.js";
import { ViewerStore } from "./store.js";
import { installTestHooks } from "./testHooks.js";
import { watchUrl } from "./url.js";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const loaded = loadBundle();

if (loaded.ok) {
  const store = new ViewerStore(loaded.bundle, readLaunchParams());
  installTestHooks(store);
  watchUrl(store, loaded.bundle.mode);
  root.render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
} else {
  root.render(
    <main className="no-data">
      <h1>xpl viewer</h1>
      <p data-testid="no-data">{loaded.error}</p>
      <p>
        Open an explainer with <code>xpl view &lt;explainer&gt;</code>, or build a self-contained
        page with <code>xpl bundle &lt;explainer&gt; -o explainer.html</code>.
      </p>
    </main>,
  );
}
