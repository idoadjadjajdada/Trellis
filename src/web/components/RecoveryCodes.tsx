import { useState } from 'react';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <div>
      <div className="codes mono" aria-label="Recovery codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="small"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          className="button small"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Trellis recovery codes\n\n${text}\n`)}`}
          download="trellis-recovery-codes.txt"
        >
          Download
        </a>
      </div>
    </div>
  );
}
