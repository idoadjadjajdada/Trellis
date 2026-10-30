import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Me, Settings } from '../../shared/types';
import { api, errorMessage } from '../api';
import { formatDate } from '../components/AtomDetails';
import { RecoveryCodes } from '../components/RecoveryCodes';
import { useStore } from '../store';
import { addPasskey, passkeyError } from './SignIn';

interface ApiKeyInfo { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }
interface ConnectedApp { clientId: string; name: string; connectedAt: string; lastUsedAt: string }
interface PasskeyInfo { id: string; name: string; createdAt: string; lastUsedAt: string | null }

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="card" style={{ marginBottom: 16 }} id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
      <button
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => {});
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, setError, reload };
}

function ConnectSection({ mcpUrl }: { mcpUrl: string }) {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)/.test(mcpUrl);
  return (
    <Section title="Connect an AI" id="connect">
      <p>Add this address as a connector, then sign in and choose Allow. The AI then saves notes as you talk.</p>
      <CopyField value={mcpUrl} label="Connector URL" />
      {local && (
        <p className="muted small-text" style={{ marginTop: 8 }}>
          This server runs on your computer, so claude.ai and ChatGPT cannot reach it unless you tunnel it to a public https address. Claude Desktop can use it
          directly with an API key (below).
        </p>
      )}
      <h3 style={{ marginTop: 14 }}>Claude</h3>
      <ol className="small-text" style={{ paddingLeft: 18, margin: 0 }}>
        <li>In Claude, open Customize, then Connectors, and choose Add custom connector.</li>
        <li>Paste the address above, add it, then choose Connect.</li>
        <li>Sign in to Trellis with your passkey and choose Allow.</li>
      </ol>
      <h3 style={{ marginTop: 14 }}>ChatGPT</h3>
      <ol className="small-text" style={{ paddingLeft: 18, margin: 0 }}>
        <li>In ChatGPT, open Plugins and add a custom MCP server (on some plans this needs Developer mode in Settings).</li>
        <li>Paste the address above and choose OAuth for authentication.</li>
        <li>Sign in to Trellis with your passkey and choose Allow.</li>
      </ol>
      <p className="muted small-text" style={{ marginTop: 8 }}>ChatGPT changes this setup often; if these steps do not match, check OpenAI's current help pages.</p>
    </Section>
  );
}

function DesktopSnippet({ apiKey, mcpUrl }: { apiKey: string; mcpUrl: string }) {
  const origin = new URL(mcpUrl).origin;
  const docker = JSON.stringify(
    { mcpServers: { trellis: { command: 'docker', args: ['exec', '-i', '-e', `TRELLIS_API_KEY=${apiKey}`, 'trellis', 'node', 'dist/server/stdio-bridge.js'] } } },
    null,
    2,
  );
  const node = JSON.stringify(
    { mcpServers: { trellis: { command: 'node', args: ['/path/to/Trellis/dist/server/stdio-bridge.js'], env: { TRELLIS_URL: origin, TRELLIS_API_KEY: apiKey } } } },
    null,
    2,
  );
  return (
    <div className="small-text">
      <p style={{ marginTop: 10 }}>For Claude Desktop with the local version, add this to claude_desktop_config.json, then restart Claude Desktop:</p>
      <pre className="snippet">{docker}</pre>
      <p>Not using Docker? Point Node at your Trellis folder instead:</p>
      <pre className="snippet">{node}</pre>
    </div>
  );
}

function AppsSection() {
  const { data, error, setError, reload } = useLoad<{ apps: ConnectedApp[] }>('/apps');
  return (
    <Section title="Connected apps">
      {error && <p className="error">{error}</p>}
      {data?.apps.length === 0 && <p className="muted">No AI apps are connected yet.</p>}
      <table className="table">
        <tbody>
          {data?.apps.map((app) => (
            <tr key={app.clientId}>
              <td>
                {app.name}
                <div className="muted small-text">Connected {formatDate(app.connectedAt)} · last sign-in {formatDate(app.lastUsedAt)}</div>
              </td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="small danger"
                  onClick={async () => {
                    if (!window.confirm(`Disconnect ${app.name}? It will need to sign in again.`)) return;
                    try {
                      await api.del(`/apps/${encodeURIComponent(app.clientId)}`);
                      await reload();
                    } catch (err) {
                      setError(errorMessage(err));
                    }
                  }}
                >
                  Disconnect
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function ApiKeysSection({ mcpUrl, apiUrl }: { mcpUrl: string; apiUrl: string }) {
  const { data, error, setError, reload } = useLoad<{ keys: ApiKeyInfo[] }>('/keys');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Section title="API keys">
      <p className="muted small-text">
        For Claude Desktop with the local version, or your own scripts. Send the key as <code>Authorization: Bearer &lt;key&gt;</code> to the connector
        address or to the REST API at <code>{apiUrl}</code>.
      </p>
      {error && <p className="error">{error}</p>}
      <form
        className="row"
        style={{ flexWrap: 'nowrap', marginBottom: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const submitted = name;
            const res = await api.post<{ key: string }>('/keys', { name: submitted });
            setCreated(res.key);
            // Keep anything typed while the request was running.
            setName((cur) => (cur === submitted ? '' : cur));
            await reload();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <input placeholder="Key name, e.g. Claude Desktop" value={name} onChange={(e) => setName(e.target.value)} aria-label="New key name" maxLength={60} />
        <button type="submit" disabled={!name.trim()}>Create key</button>
      </form>
      {created && (
        <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 10 }}>
          <p style={{ marginTop: 0 }}>Copy this key now. You will not see it again.</p>
          <CopyField value={created} label="New API key" />
          <DesktopSnippet apiKey={created} mcpUrl={mcpUrl} />
          <button className="small" onClick={() => setCreated(null)}>Done</button>
        </div>
      )}
      <table className="table">
        <tbody>
          {data?.keys.map((k) => (
            <tr key={k.id}>
              <td>
                {k.name} <span className="muted mono">{k.prefix}…</span>
                <div className="muted small-text">
                  Created {formatDate(k.createdAt)} · {k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt)}` : 'never used'}
                </div>
              </td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="small danger"
                  onClick={async () => {
                    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working.`)) return;
                    try {
                      await api.del(`/keys/${k.id}`);
                      await reload();
                    } catch (err) {
                      setError(errorMessage(err));
                    }
                  }}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function ProjectsSection() {
  const { graph, refresh, showToast } = useStore();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Section title="Projects">
      <p className="muted small-text">Each project is a layer in the graph with its own color. The AI picks from these names.</p>
      {error && <p className="error">{error}</p>}
      <form
        className="row"
        style={{ flexWrap: 'nowrap', marginBottom: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          const submitted = name;
          void act(async () => {
            await api.post('/projects', { name: submitted });
            setName((cur) => (cur === submitted ? '' : cur));
          });
        }}
      >
        <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New project name" maxLength={80} />
        <button type="submit" disabled={!name.trim()}>Add project</button>
      </form>
      <table className="table">
        <tbody>
          {graph?.projects.map((p) => (
            <tr key={p.id}>
              <td style={{ width: 44 }}>
                <input
                  type="color"
                  value={p.color}
                  aria-label={`Color for ${p.name}`}
                  onChange={(e) => void act(() => api.patch(`/projects/${p.id}`, { color: e.target.value }))}
                />
              </td>
              <td>
                {renaming?.id === p.id ? (
                  <form
                    className="row"
                    style={{ flexWrap: 'nowrap' }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        await api.patch(`/projects/${p.id}`, { name: renaming.name });
                        setRenaming(null);
                      });
                    }}
                  >
                    <input value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} autoFocus aria-label="Project name" />
                    <button type="submit" className="small primary">Save</button>
                    <button type="button" className="small" onClick={() => setRenaming(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    {p.name} <span className="muted small-text">{p.atomCount} notes</span>
                  </>
                )}
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {renaming?.id !== p.id && (
                  <>
                    <button className="small ghost" onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>
                    <button
                      className="small ghost danger"
                      onClick={() => {
                        if (!window.confirm(`Delete the project "${p.name}"? Its notes move to Unsorted.`)) return;
                        void act(async () => {
                          await api.del(`/projects/${p.id}`);
                          showToast(`Deleted ${p.name}. Its notes are in Unsorted.`);
                        });
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function GraphSection() {
  const { refresh } = useStore();
  const { data, error, setError } = useLoad<Settings>('/settings');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [baseline, setBaseline] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) {
      setDraft(data);
      setBaseline(data);
    }
  }, [data]);
  if (!draft || !baseline) return <Section title="Graph">{error ? <p className="error">{error}</p> : <div className="spinner" />}</Section>;
  const changed = draft.linkThreshold !== baseline.linkThreshold || draft.duplicateThreshold !== baseline.duplicateThreshold;
  return (
    <Section title="Graph">
      <label className="field">
        <span>Link notes when they are at least {Math.round(draft.linkThreshold * 100)}% similar</span>
        <input
          type="range"
          min={0.4}
          max={0.95}
          step={0.01}
          value={draft.linkThreshold}
          onChange={(e) => setDraft({ ...draft, linkThreshold: Number(e.target.value) })}
          aria-label="Link threshold"
        />
      </label>
      <label className="field">
        <span>Treat a new note as a duplicate when it is at least {Math.round(draft.duplicateThreshold * 100)}% similar</span>
        <input
          type="range"
          min={0.8}
          max={0.99}
          step={0.01}
          value={draft.duplicateThreshold}
          onChange={(e) => setDraft({ ...draft, duplicateThreshold: Number(e.target.value) })}
          aria-label="Duplicate threshold"
        />
      </label>
      <p className="muted small-text">Lower link values connect more notes. A duplicate raises the weight of the existing note instead of adding a new one.</p>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        {saved && !changed && <span className="muted small-text">Saved</span>}
        <button
          className="primary"
          disabled={!changed}
          onClick={async () => {
            try {
              const next = await api.patch<Settings>('/settings', draft);
              setDraft(next);
              setBaseline(next);
              setSaved(true);
              await refresh();
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          Save
        </button>
      </div>
    </Section>
  );
}

function AccountSection({ me, onMeChange, onSignOut }: { me: Me; onMeChange: (me: Me) => void; onSignOut: () => void }) {
  const passkeys = useLoad<{ passkeys: PasskeyInfo[] }>('/passkeys');
  const recovery = useLoad<{ remaining: number }>('/recovery-codes');
  const [name, setName] = useState(me.displayName);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Account">
      <form
        className="row"
        style={{ flexWrap: 'nowrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => onMeChange(await api.patch<Me>('/me', { displayName: name })));
        }}
      >
        <label className="field grow" style={{ margin: 0 }}>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <button type="submit" style={{ alignSelf: 'flex-end' }} disabled={busy || !name.trim() || name.trim() === me.displayName}>
          Save
        </button>
      </form>

      <div className="divider" />
      <h3>Passkeys</h3>
      <p className="muted small-text">Add a passkey on each device you use, so losing one device never locks you out.</p>
      <table className="table">
        <tbody>
          {passkeys.data?.passkeys.map((p) => (
            <tr key={p.id}>
              <td>
                {p.name}
                <div className="muted small-text">
                  Added {formatDate(p.createdAt)}
                  {p.lastUsedAt ? ` · last used ${formatDate(p.lastUsedAt)}` : ''}
                </div>
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button
                  className="small ghost"
                  onClick={() => {
                    const next = window.prompt('Passkey name', p.name);
                    if (next && next.trim()) void act(async () => { await api.patch(`/passkeys/${encodeURIComponent(p.id)}`, { name: next }); await passkeys.reload(); });
                  }}
                >
                  Rename
                </button>
                <button
                  className="small ghost danger"
                  disabled={(passkeys.data?.passkeys.length ?? 0) <= 1}
                  title={(passkeys.data?.passkeys.length ?? 0) <= 1 ? 'Add another passkey first' : undefined}
                  onClick={() => {
                    if (window.confirm(`Remove the passkey "${p.name}"?`))
                      void act(async () => { await api.del(`/passkeys/${encodeURIComponent(p.id)}`); await passkeys.reload(); });
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button style={{ marginTop: 8 }} disabled={busy} onClick={() => act(async () => { await addPasskey(); await passkeys.reload(); })}>
        Add a passkey
      </button>

      <div className="divider" />
      <h3>Recovery codes</h3>
      <p className="muted small-text">
        {recovery.data ? `${recovery.data.remaining} of 10 codes left.` : ''} Making new codes cancels the old ones.
      </p>
      {codes ? (
        <RecoveryCodes codes={codes} />
      ) : (
        <button
          disabled={busy}
          onClick={() => {
            if (window.confirm('Make new recovery codes? Your old codes will stop working.'))
              void act(async () => { setCodes((await api.post<{ recoveryCodes: string[] }>('/recovery-codes')).recoveryCodes); await recovery.reload(); });
          }}
        >
          Make new recovery codes
        </button>
      )}

      <div className="divider" />
      <button onClick={onSignOut}>Sign out</button>
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  );
}

export function SettingsPage({ me, onMeChange, onSignOut }: { me: Me; onMeChange: (me: Me) => void; onSignOut: () => void }) {
  const connection = useLoad<{ mcpUrl: string; apiUrl: string }>('/connection');
  return (
    <div>
      <h1>Settings</h1>
      {connection.data && <ConnectSection mcpUrl={connection.data.mcpUrl} />}
      <AppsSection />
      {connection.data && <ApiKeysSection mcpUrl={connection.data.mcpUrl} apiUrl={connection.data.apiUrl} />}
      <ProjectsSection />
      <GraphSection />
      <AccountSection me={me} onMeChange={onMeChange} onSignOut={onSignOut} />
      <Section title="Trash">
        <p className="muted small-text">Deleted notes stay in Trash for 30 days.</p>
        <Link className="button" to="/trash">Open Trash</Link>
      </Section>
    </div>
  );
}
