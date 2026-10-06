'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import type { KanbanOpenRevision, MediaItem, SopListItem } from '@/lib/types';

export interface Kanban {
  id: string;
  partCode: string;
  partDescription: string | null;
  supplier: string | null;
  supplierPartNo: string | null;
  usedFor: string | null;
  orderWhen: string | null;
  orderQty: string | null;
  deliveryTime: string | null;
  location: string | null;
  price: number | null;
  carriage: number | null;
  customField1: string | null;
  customField2: string | null;
  orderingType: 'url' | 'sop' | 'email';
  orderingUrl: string | null;
  orderingSopId: string | null;
  orderingEmail: string | null;
  orderingSop: { id: string; name: string; referenceNo: string } | null;
  tag: string | null;
  color: string | null;
  barcode: string | null;
  template: '01' | '02';
  picture: MediaItem | null;
  media: MediaItem[];
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  updatedAt: string;
  /** Set by GET /kanbans and GET /kanbans/:id only. Null when the card has no open revision. */
  openRevision?: KanbanOpenRevision | null;
}

type FormState = Record<string, string>;

/** Plain text fields sent as-is (empty → null). Max lengths mirror the API DTO. */
const TEXT_FIELDS = [
  'partCode',
  'partDescription',
  'supplier',
  'supplierPartNo',
  'usedFor',
  'location',
  'orderWhen',
  'orderQty',
  'deliveryTime',
  'tag',
  'barcode',
  'customField1',
  'customField2',
] as const;

const DEFAULT_COLOR = '#b0825e';
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function initial(k?: Kanban): FormState {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, s(k?.[f])])),
    price: s(k?.price),
    carriage: s(k?.carriage),
    color: s(k?.color) || DEFAULT_COLOR,
    template: k?.template ?? '01',
    orderingType: k?.orderingType ?? 'url',
    orderingUrl: s(k?.orderingUrl),
    orderingEmail: s(k?.orderingEmail),
    orderingSopId: s(k?.orderingSopId),
  };
}

/** Full-page Add / Edit Kanban form: picture on the left, card details on the right, Cancel / Save in the bar. */
export function KanbanEditor({ kanban, copyFrom }: { kanban?: Kanban; copyFrom?: Kanban }) {
  const router = useRouter();
  const [f, setF] = useState<FormState>(() =>
    copyFrom ? { ...initial(copyFrom), partCode: `${copyFrom.partCode} (Copy)`.slice(0, 100) } : initial(kanban),
  );
  const [picture, setPicture] = useState<MediaItem | null>((kanban ?? copyFrom)?.picture ?? null);
  const [sops, setSops] = useState<SopListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    api<{ items: SopListItem[] }>('/sops?limit=200')
      .then((r) => setSops(r.items))
      .catch(() => undefined);
  }, []);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function uploadPicture(file?: File | null) {
    if (!file) return;
    if (!PICTURE_TYPES.includes(file.type)) return setError('The picture must be a PNG, JPEG, GIF or WebP image.');
    setError(null);
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await apiRaw('/media', { method: 'POST', rawBody: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.message ?? 'Upload failed');
      else setPicture(body as MediaItem);
    } finally {
      setUploading(false);
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void uploadPicture(e.dataTransfer.files?.[0]);
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void uploadPicture(file);
    }
  };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (formRef.current && !formRef.current.reportValidity()) return;
    setBusy(true);
    setError(null);
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    const body: Record<string, unknown> = {
      ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, f[k].trim() === '' ? null : f[k].trim()])),
      partCode: f.partCode.trim(),
      price: f.template === '02' ? num(f.price) : null,
      carriage: f.template === '02' ? num(f.carriage) : null,
      color: f.color,
      template: f.template,
      orderingType: f.orderingType,
      orderingUrl: f.orderingType === 'url' ? f.orderingUrl.trim() : null,
      orderingEmail: f.orderingType === 'email' ? f.orderingEmail.trim() : null,
      orderingSopId: f.orderingType === 'sop' ? f.orderingSopId || null : null,
      pictureAssetId: picture?.id ?? null,
    };
    try {
      await api(kanban ? `/kanbans/${kanban.id}` : '/kanbans', { method: kanban ? 'PATCH' : 'POST', body });
      router.push(kanban ? `/kanbans/${kanban.id}` : '/kanbans');
    } catch (err) {
      setError(errorMessage(err));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <div className="kanban-actions">
      <Link href={kanban ? `/kanbans/${kanban.id}` : '/kanbans'} className="btn kanban-cancel">
        Cancel
      </Link>
      <button type="button" className="btn btn-primary kanban-save" disabled={busy || uploading} onClick={() => void submit()}>
        {busy ? 'Saving…' : 'Save draft'}
      </button>
    </div>
  );

  const field = (k: string, label: string, max: number, opts: { required?: boolean; placeholder?: string; type?: string } = {}) => (
    <Field id={`k-${k}`} label={label} >
      <input
        id={`k-${k}`}
        type={opts.type ?? 'text'}
        value={f[k]}
        required={opts.required}
        placeholder={opts.placeholder ?? label.replace(/ \*$| \(Optional\)$/, '')}
        onChange={set(k)}
      />
    </Field>
  );

  return (
    <>
      <SubbarLeft>
        <Link href="/kanbans" className="back-btn">
          <span className="back-chev">‹</span> Back
        </Link>
        <strong className="bar-title">{kanban ? `Edit Kanban — ${kanban.partCode}` : copyFrom ? `Duplicate Kanban — ${copyFrom.partCode}` : 'Add Kanban'}</strong>
      </SubbarLeft>
      <SubbarRight>{actions}</SubbarRight>

      <form ref={formRef} className="kanban-editor" onSubmit={submit} onPaste={onPaste}>
        <aside className="kanban-photo">
          <div className="kanban-photo-label">Take a picture</div>
          <div
            className={`kanban-drop${dragOver ? ' over' : ''}${picture ? ' has-image' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Upload a picture"
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={picture.url} alt="Kanban picture" />
            ) : (
              <span className="kanban-drop-icon" aria-hidden>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </span>
            )}
            {uploading && <span className="kanban-drop-busy">Uploading…</span>}
          </div>
          <div className="kanban-photo-hint">Drop or Paste Image</div>
          <input ref={fileInput} type="file" accept={PICTURE_TYPES.join(',')} hidden onChange={(e) => void uploadPicture(e.target.files?.[0])} />
          <button type="button" className="btn btn-primary btn-block" disabled={uploading} onClick={() => fileInput.current?.click()}>
            Upload/Change Photo
          </button>
          {picture && (
            <button type="button" className="btn btn-block" onClick={() => setPicture(null)}>
              Remove Photo
            </button>
          )}
        </aside>

        <div className="kanban-fields">
          {error && <div className="error">{error}</div>}

          <div className="kf-row kf-2">
            <div className="field">
              <span className="kf-label">Kanban Type</span>
              <div className="kf-radios">
                <Radio name="template" value="01" current={f.template} onChange={set('template')} label="Template 01" />
                <Radio name="template" value="02" current={f.template} onChange={set('template')} label="Template 02 (with price & carriage)" />
              </div>
            </div>
          </div>

          <Field id="k-partDescription" label="Part Description">
            <textarea id="k-partDescription" rows={3} placeholder="Part Description" value={f.partDescription} onChange={set('partDescription')} />
          </Field>

          <div className="field">
            <span className="kf-label">QR Code Options (for back of the card)</span>
            <div className="kf-radios">
              <Radio name="orderingType" value="url" current={f.orderingType} onChange={set('orderingType')} label="Ordering Item URL" />
              <Radio name="orderingType" value="sop" current={f.orderingType} onChange={set('orderingType')} label="SOP" />
              <Radio name="orderingType" value="email" current={f.orderingType} onChange={set('orderingType')} label="Email" />
            </div>
          </div>
          {f.orderingType === 'url' && (
            <Field id="k-orderingUrl" label="Ordering Item URL (Optional)" hint="Paste the supplier's web link (http:// or https://). It is encoded in the QR code on the back of the card.">
              <textarea id="k-orderingUrl" rows={2} placeholder="Ordering Item URL" value={f.orderingUrl} onChange={set('orderingUrl')} />
            </Field>
          )}
          {f.orderingType === 'email' && (
            <Field id="k-orderingEmail" label="Ordering Email *" hint="Scanning the QR code opens an order email to this address.">
              <input id="k-orderingEmail" type="email" required placeholder="purchasing@example.com" value={f.orderingEmail} onChange={set('orderingEmail')} />
            </Field>
          )}
          {f.orderingType === 'sop' && (
            <Field id="k-orderingSopId" label="Ordering SOP *" hint="Scanning the QR code opens this SOP.">
              <select id="k-orderingSopId" required value={f.orderingSopId} onChange={set('orderingSopId')}>
                <option value="">Choose SOP…</option>
                {sops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.referenceNo} — {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <hr className="kf-sep" />

          <div className="kf-row kf-3">
            {field('barcode', 'Barcode Number (Code 128) (Optional)', 200)}
            {field('usedFor', 'Used For', 500)}
            {field('supplierPartNo', 'Supplier Part Number (Optional)', 200)}
          </div>
          <div className="kf-row kf-3">
            {field('partCode', 'Sawo Inc Part Number *', 100, { required: true, placeholder: 'Part Number' })}
            {field('supplier', 'Supplier', 200)}
            {field('orderWhen', 'Order When', 200)}
          </div>
          <div className="kf-row kf-3">
            {field('orderQty', 'Order Qty', 200)}
            {field('deliveryTime', 'Delivery Time', 200)}
            {field('location', 'Location (Optional)', 200)}
          </div>
          {f.template === '02' && (
            <div className="kf-row kf-3">
              {field('price', 'Price', 13, { type: 'number' })}
              {field('carriage', 'Carriage', 13, { type: 'number' })}
            </div>
          )}
          <div className="kf-row kf-3">
            <Field id="k-color" label="PDF Header Color">
              <input id="k-color" type="color" className="kf-color" value={f.color} onChange={set('color')} />
            </Field>
            {field('customField1', 'Custom Field 1 (Optional)', 500)}
            {field('customField2', 'Custom Field 2 (Optional)', 500)}
          </div>
          <Field id="k-tag" label="Tags (Optional)" hint="Type a tag and press Enter (or comma) to add it. Add as many as you need.">
            <TagInput value={f.tag} onChange={(v) => setF((st) => ({ ...st, tag: v }))} />
          </Field>
        </div>
      </form>

      <div className="kanban-footer">
        <span className="muted" style={{ marginRight: 'auto', fontSize: 13 }}>
          Saving creates a draft. The card on the Kanban list changes only after it is approved and published.
        </span>
        {actions}
      </div>
    </>
  );
}

/** Tags are kept as one comma-separated text value ("bearings, spare"); this edits them as chips. */
export const splitTags = (v: string | null | undefined) => (v ?? '').split(',').map((t) => t.trim()).filter(Boolean);

function TagInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState('');
  const tags = splitTags(value);
  const commit = (raw: string) => {
    const add = raw.split(',').map((t) => t.trim()).filter((t) => t && !tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    if (add.length) onChange([...tags, ...add].join(', '));
    setText('');
  };
  return (
    <div className="tag-input">
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t).join(', '))}>
            ×
          </button>
        </span>
      ))}
      <input
        id="k-tag"
        value={text}
        placeholder={tags.length ? '' : 'Enter a tag, e.g. bearings'}
        onChange={(e) => (e.target.value.includes(',') ? commit(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(text);
          } else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1).join(', '));
        }}
        onBlur={() => commit(text)}
      />
    </div>
  );
}

function Field({ id, label, count, hint, children }: { id: string; label: string; count?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="kf-head">
        <label htmlFor={id}>{label}</label>
        {count && <span className="kf-count">{count}</span>}
      </div>
      {children}
      {hint && <div className="kf-hint">{hint}</div>}
    </div>
  );
}

function Radio({ name, value, current, label, onChange }: { name: string; value: string; current: string; label: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <label className="kf-radio">
      <input type="radio" name={name} value={value} checked={current === value} onChange={onChange} />
      {label}
    </label>
  );
}
