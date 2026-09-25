import { useEffect, useState, type FormEvent } from "react";
import type { ConfigView } from "@eodview/shared";
import { ApiRequestError } from "../api/http";
import { useStore } from "../state/store";
import { configApi } from "./configApi";
import { Modal } from "./Modal";
import { useShell } from "./shellStore";

const SOURCE_LABEL: Record<ConfigView["keySource"], string> = {
  file: "server/data/config.json",
  env: "EODHD_API_KEY environment variable",
  none: "not configured",
};

const FORBIDDEN_HINT =
  "The server refused this change (403). Config changes are only accepted from localhost, " +
  "or — when the server sets EODVIEW_ADMIN_TOKEN — with that token. Enter the admin token below and try again, " +
  "or run `bun run server/src/cli.ts set-key <KEY>` on the server.";

export function SettingsDialog() {
  const open = useStore((s) => s.ui.settingsOpen);
  if (!open) return null;
  return <SettingsDialogInner />;
}

function describeError(e: unknown): { message: string; forbidden: boolean } {
  if (e instanceof ApiRequestError) {
    if (e.status === 403 || e.status === 401) return { message: FORBIDDEN_HINT, forbidden: true };
    return { message: e.detail ? `${e.message}: ${e.detail}` : e.message, forbidden: false };
  }
  return { message: e instanceof Error ? e.message : String(e), forbidden: false };
}

function SettingsDialogInner() {
  const config = useShell((s) => s.config);
  const notice = useShell((s) => s.settingsNotice);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [needsToken, setNeedsToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const close = () => {
    useStore.getState().setUi({ settingsOpen: false });
    useShell.setState({ settingsNotice: null });
  };

  // Refresh the config view whenever the dialog opens.
  useEffect(() => {
    let cancelled = false;
    configApi
      .get()
      .then((c) => !cancelled && useShell.getState().setConfig(c))
      .catch((e: unknown) => {
        if (cancelled) return;
        const d = describeError(e);
        if (d.forbidden) setNeedsToken(true);
        setLoadError(d.forbidden ? "Current configuration is only visible from localhost or with the admin token." : d.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const apiKey = key.trim();
    if (!apiKey) {
      setError("Paste your EODHD API key.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const view = await configApi.setKey(apiKey, adminToken.trim() || undefined);
      useShell.getState().setConfig(view);
      useShell.setState({ settingsNotice: null });
      setKey("");
      setSaved(true);
      setLoadError(null);
      useShell.getState().pushToast({ kind: "success", title: "EODHD key saved", body: view.plan?.name ? `Plan: ${view.plan.name}` : undefined });
    } catch (err) {
      const d = describeError(err);
      if (d.forbidden) setNeedsToken(true);
      setError(d.message);
    } finally {
      setBusy(false);
    }
  };

  const plan = config?.plan;
  return (
    <Modal title="Settings" onClose={close} width={520} className="settings-modal">
      <div className="modal-body">
        {notice && <div className="notice">{notice}</div>}

        <section className="settings-section">
          <h3>EODHD API key</h3>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              {config ? (
                config.hasKey ? <span className="up">Configured</span> : <span className="warn">Missing</span>
              ) : (
                <span className="muted">{loadError ?? "Loading…"}</span>
              )}
            </dd>
            {config && (
              <>
                <dt>Source</dt>
                <dd>{SOURCE_LABEL[config.keySource]}</dd>
                <dt>Key</dt>
                <dd className="mono">{config.keyMasked ?? "—"}</dd>
              </>
            )}
            {plan && (
              <>
                <dt>Plan</dt>
                <dd>{plan.name ?? "—"}</dd>
                {plan.email && (
                  <>
                    <dt>Account</dt>
                    <dd>{plan.email}</dd>
                  </>
                )}
                {(plan.apiRequests !== undefined || plan.dailyRateLimit !== undefined) && (
                  <>
                    <dt>API usage today</dt>
                    <dd className="mono">
                      {plan.apiRequests?.toLocaleString() ?? "?"} / {plan.dailyRateLimit?.toLocaleString() ?? "?"}
                    </dd>
                  </>
                )}
              </>
            )}
            {config && (
              <>
                <dt>Server port</dt>
                <dd className="mono">{config.port}</dd>
              </>
            )}
          </dl>
        </section>

        <form className="settings-section" onSubmit={submit}>
          <h3>{config?.hasKey ? "Replace key" : "Set key"}</h3>
          <div className="input-with-btn">
            <input
              className="input mono"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your EODHD API key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setSaved(false);
              }}
              autoFocus
            />
            <button type="button" className="btn btn-ghost" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          {needsToken && (
            <label className="field">
              <span>Admin token (EODVIEW_ADMIN_TOKEN)</span>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
              />
            </label>
          )}
          <p className="hint">
            The key is validated against EODHD, stored on the server in <code>server/data/config.json</code> and applied
            immediately. It is never sent to the browser.
          </p>
          {error && <div className="error-text" role="alert">{error}</div>}
          {saved && <div className="success-text">Key validated and saved. Live data is reconnecting.</div>}
          <div className="form-row end">
            <button type="button" className="btn btn-ghost" onClick={close}>Close</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>
              {busy ? "Validating…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
