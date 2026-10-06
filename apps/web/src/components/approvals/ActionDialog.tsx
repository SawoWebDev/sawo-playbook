'use client';

import { useState, type ReactNode } from 'react';

/**
 * Confirmation for an approval action. Reject requires a comment and shows it before confirming; the server still
 * validates it. The dialog never decides whether the action is allowed: the caller only opens it for actions the
 * server offered.
 */
export function ActionDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  requireComment = false,
  commentLabel = 'Reason (shown to the submitter)',
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireComment?: boolean;
  commentLabel?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const trimmed = comment.trim();
  const blocked = busy || (requireComment && !trimmed);
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="muted" style={{ marginBottom: 10 }}>{children}</div>
        {requireComment && (
          <div className="field">
            <label htmlFor="action-comment">{commentLabel}</label>
            <textarea id="action-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} style={{ width: '100%' }} />
            {requireComment && !trimmed && <p className="muted" style={{ fontSize: 12 }}>A reason is required.</p>}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} type="button" disabled={blocked} onClick={() => onConfirm(trimmed)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
