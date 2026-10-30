import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';

interface Pending {
  id: string;
  clientName: string;
  redirectHost: string;
}

/** OAuth consent: an AI app (Claude, ChatGPT) asks to read and save notes. */
export function Consent({ requestId, userName }: { requestId: string; userName: string }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Pending>(`/oauth/requests/${encodeURIComponent(requestId)}`).then(setPending, (err) => setError(errorMessage(err)));
  }, [requestId]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const { redirectTo } = await api.post<{ redirectTo: string }>(`/oauth/requests/${encodeURIComponent(requestId)}`, { approve });
      window.location.assign(redirectTo);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card auth-card stack">
        <div className="logo">
          <img src="/icons/icon.svg" alt="" />
          <h1 style={{ margin: 0 }}>Connect to Trellis</h1>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {!pending && !error && <div className="spinner" />}
        {pending && (
          <>
            <p>
              <strong>{pending.clientName}</strong> wants to search, save and update notes in your Trellis account ({userName}).
            </p>
            <p className="muted small-text">
              After you allow it, you will go back to <strong>{pending.redirectHost}</strong>. You can disconnect it any time in Settings.
            </p>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="grow" disabled={busy} onClick={() => decide(false)}>Deny</button>
              <button className="grow primary" disabled={busy} onClick={() => decide(true)}>Allow</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
