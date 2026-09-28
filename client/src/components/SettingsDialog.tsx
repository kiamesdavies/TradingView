import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiTokenView, ConfigView, DeploymentInfo } from "@eodview/shared";
import { api } from "../api/http";
import { connectCommands } from "./connectInfo";
import { ApiRequestError } from "../api/http";
import { claudeMcpAddCommand, isLoopbackHost, mcpUrl, serverOrigin, TOKEN_ENV } from "../screener/apiLinks";
import { copyText, tokensApi, type CreatedToken } from "../screener/tokensApi";
import "../screener/apiAccess.css";
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

        <ConnectSection />

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

        <ApiAccessSection adminToken={adminToken.trim() || undefined} onForbidden={() => setNeedsToken(true)} serverPort={config?.port} />

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

// ---------------- API access (agent API tokens + MCP endpoint) ----------------

function fmtTime(t: number | null): string {
  if (!t) return "never";
  const d = new Date(t * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost api-copy"
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) useShell.getState().pushToast({ kind: "error", title: "Copy failed — select the text and copy it manually" });
        setDone(ok);
        if (ok) setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function ApiAccessSection({ adminToken, onForbidden, serverPort }: {
  adminToken: string | undefined;
  onForbidden: () => void;
  serverPort: number | undefined;
}) {
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown, set: (m: string) => void) => {
      if (e instanceof ApiRequestError && e.status === 404) {
        set("The agent API is not available on this server (404) — update the server.");
        return;
      }
      const d = describeError(e);
      if (d.forbidden) onForbidden();
      set(d.message);
    },
    [onForbidden],
  );

  const load = useCallback(() => {
    let cancelled = false;
    tokensApi
      .list(adminToken)
      .then((list) => {
        if (cancelled) return;
        setTokens(Array.isArray(list) ? list : []);
        setListError(null);
      })
      .catch((e: unknown) => !cancelled && fail(e, setListError));
    return () => {
      cancelled = true;
    };
  }, [adminToken, fail]);
  useEffect(() => load(), [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("Give the token a name, e.g. the agent that will use it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await tokensApi.create(n, adminToken);
      setCreated(t);
      setName("");
      const { token: _secret, ...view } = t;
      setTokens((list) => [...(list ?? []).filter((x) => x.id !== t.id), view]);
    } catch (err) {
      fail(err, setError);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await tokensApi.revoke(id, adminToken);
      setTokens((list) => (list ?? []).filter((x) => x.id !== id));
      if (created?.id === id) setCreated(null);
      setConfirmRevoke(null);
    } catch (err) {
      fail(err, setError);
    } finally {
      setBusy(false);
    }
  };

  const origin = serverOrigin(window.location, serverPort);
  const url = mcpUrl(origin);
  const remote = !isLoopbackHost(window.location.hostname);
  const addCmd = claudeMcpAddCommand(url, remote);
  const devProxy = window.location.port === "5173";

  return (
    <section className="settings-section api-access">
      <h3>API access</h3>
      <p className="hint">
        Agents can call the screener over REST (<code>/api/v1/screen</code>, spec at <code>/api/openapi.json</code>) or
        MCP. Callers on this machine need no token; others send <code>Authorization: Bearer &lt;token&gt;</code>.
        Tokens are read-only.
      </p>

      <dl className="kv">
        <dt>MCP endpoint</dt>
        <dd className="api-line">
          <code className="mono">{url}</code>
          <CopyButton text={url} />
        </dd>
        <dt>Claude Code</dt>
        <dd className="api-line">
          <code className="mono">{addCmd}</code>
          <CopyButton text={addCmd} />
        </dd>
      </dl>
      {devProxy && (
        <p className="hint">
          Dev mode: the page runs on Vite (5173); the URL points at the server
          port{serverPort ? ` (${serverPort})` : " (3001 assumed)"}.
        </p>
      )}
      {remote && (
        <p className="hint">
          Replace <code>&lt;token&gt;</code> with a token created below; for REST/curl export it as <code>{TOKEN_ENV}</code>.
        </p>
      )}

      <div className="api-tokens">
        {listError ? (
          <div className="error-text" role="alert">{listError}</div>
        ) : tokens === null ? (
          <span className="muted">Loading tokens…</span>
        ) : tokens.length === 0 ? (
          <span className="muted">No tokens yet.</span>
        ) : (
          <table className="api-token-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Created</th>
                <th>Last used</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="mono">{t.prefix}…</td>
                  <td>{fmtTime(t.createdAt)}</td>
                  <td>{fmtTime(t.lastUsedAt)}</td>
                  <td className="api-actions">
                    {confirmRevoke === t.id ? (
                      <>
                        <button type="button" className="btn btn-ghost api-copy" onClick={() => setConfirmRevoke(null)} disabled={busy}>Cancel</button>
                        <button type="button" className="btn api-danger" onClick={() => void revoke(t.id)} disabled={busy}>Revoke</button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-ghost api-copy" onClick={() => setConfirmRevoke(t.id)} disabled={busy}>Revoke…</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {created && (
        <div className="api-created" role="status">
          <div>
            <b>Token “{created.name}” created.</b> Copy it now — it is stored hashed and <b>won't be shown again</b>.
          </div>
          <div className="api-line">
            <code className="mono api-secret">{created.token}</code>
            <CopyButton text={created.token} />
            <button type="button" className="btn btn-ghost api-copy" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      )}

      <form className="input-with-btn" onSubmit={create}>
        <input
          className="input"
          placeholder="New token name (e.g. research-agent)"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn" disabled={busy || !name.trim() || !!listError && /404/.test(listError)}>
          {busy ? "Working…" : "Create token"}
        </button>
      </form>
      {error && <div className="error-text" role="alert">{error}</div>}
      {listError && (
        <div className="form-row end">
          <button type="button" className="btn btn-ghost" onClick={() => { setListError(null); setTokens(null); load(); }}>Retry</button>
        </div>
      )}
    </section>
  );
}

// ---------------- Connect & access (how to get the admin token / hook up agents) ----------------

function ConnectSection() {
  const [info, setInfo] = useState<DeploymentInfo | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .get<DeploymentInfo>("/deployment")
      .then((d) => alive && setInfo(d))
      .catch(() => undefined); // older server: section just stays hidden
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;
  const cmds = connectCommands(info, location.origin);

  return (
    <section className="settings-section connect-section">
      <h3>
        <button type="button" className="connect-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "▾" : "▸"} Connect &amp; access
        </button>
      </h3>
      {open && (
        <>
          {info.hosted && (
            <p className="hint">
              Hosted at <code>{info.publicUrl}</code> behind Cloudflare Access
              {info.gcpProject && (
                <>
                  {" "}
                  (GCP project <code>{info.gcpProject}</code>)
                </>
              )}
              . Keep these handy — this is the only place they are written down in the app.
            </p>
          )}
          {cmds.map((c) => (
            <div key={c.id} className="connect-cmd">
              <div className="connect-cmd-head">
                <span>{c.title}</span>
                <CopyButton text={c.command} />
              </div>
              <pre className="mono">{c.command}</pre>
              {c.note && <p className="hint">{c.note}</p>}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
