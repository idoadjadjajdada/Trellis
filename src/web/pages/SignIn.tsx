import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { api, errorMessage } from '../api';
import { RecoveryCodes } from '../components/RecoveryCodes';

function passkeyError(err: unknown): string {
  if (err instanceof WebAuthnError && err.code === 'ERROR_CEREMONY_ABORTED') return 'Cancelled.';
  if (err instanceof Error && err.name === 'NotAllowedError') return 'Cancelled, or the passkey was not allowed.';
  return errorMessage(err);
}

export async function signInWithPasskey() {
  const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/login/options');
  const response = await startAuthentication({ optionsJSON: options });
  await api.post('/auth/login/verify', response);
}

export function SignIn({ onSignedIn, subtitle }: { onSignedIn: () => void; subtitle?: string }) {
  const [mode, setMode] = useState<'signin' | 'create' | 'recovery'>('signin');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [allowSignup, setAllowSignup] = useState(true);
  const supported = browserSupportsWebAuthn();

  useEffect(() => {
    api.get<{ allowSignup: boolean }>('/auth/config').then((c) => setAllowSignup(c.allowSignup), () => {});
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          <h1>Save your recovery codes</h1>
          <p className="muted">
            If you lose every device with your passkey, one of these codes lets you back in. Each code works once. Store them somewhere safe, like a
            password manager.
          </p>
          <RecoveryCodes codes={codes} />
          <button className="primary block" style={{ marginTop: 16 }} onClick={onSignedIn}>
            I saved my codes
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <div className="logo">
          <img src="/icons/icon.svg" alt="" />
          <h1 style={{ margin: 0 }}>Trellis</h1>
        </div>
        {subtitle && <p>{subtitle}</p>}
        {!supported && <p className="error">This browser does not support passkeys. Try a recent Safari, Chrome, Edge or Firefox.</p>}

        {mode === 'signin' && (
          <div className="stack">
            <button className="primary block" disabled={busy || !supported} onClick={() => run(async () => { await signInWithPasskey(); onSignedIn(); })}>
              Sign in with passkey
            </button>
            {allowSignup && (
              <button className="block" disabled={busy} onClick={() => { setMode('create'); setError(null); }}>
                Create account
              </button>
            )}
            <button className="ghost block" disabled={busy} onClick={() => { setMode('recovery'); setError(null); }}>
              Use a recovery code
            </button>
          </div>
        )}

        {mode === 'create' && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/register/options', { displayName: name });
                const response = await startRegistration({ optionsJSON: options });
                const { recoveryCodes } = await api.post<{ recoveryCodes: string[] }>('/auth/register/verify', response);
                setCodes(recoveryCodes);
              });
            }}
          >
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="name" maxLength={60} />
            </label>
            <p className="muted small-text">Trellis uses a passkey instead of a password: you unlock with your fingerprint, face or device PIN.</p>
            <button type="submit" className="primary block" disabled={busy || !name.trim() || !supported}>
              Create passkey
            </button>
            <button type="button" className="ghost block" onClick={() => setMode('signin')}>
              Back
            </button>
          </form>
        )}

        {mode === 'recovery' && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post('/auth/recovery', { code });
                onSignedIn();
              });
            }}
          >
            <label className="field">
              <span>Recovery code</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" placeholder="xxxx-xxxx-xxxx-xxxx" />
            </label>
            <button type="submit" className="primary block" disabled={busy || !code.trim()}>
              Continue
            </button>
            <button type="button" className="ghost block" onClick={() => setMode('signin')}>
              Back
            </button>
          </form>
        )}

        {busy && <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}><div className="spinner" /></div>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** Shown after signing in with a recovery code: the only thing to do is add a new passkey. */
export function AddPasskeyAfterRecovery({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="center-screen">
      <div className="card auth-card stack">
        <h1>Add a new passkey</h1>
        <p className="muted">You signed in with a recovery code. Add a passkey on this device to finish signing in.</p>
        <button
          className="primary block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await addPasskey();
              onDone();
            } catch (err) {
              setError(passkeyError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Add passkey
        </button>
        <button className="ghost block" onClick={onSignOut}>Sign out</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

export async function addPasskey() {
  const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/passkeys/options');
  const response = await startRegistration({ optionsJSON: options });
  await api.post('/passkeys/verify', response);
}

export { passkeyError };
