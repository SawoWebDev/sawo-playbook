'use client';

import { useState, type FormEvent } from 'react';
import { api, apiRaw } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import type { MediaItem, SopListItem } from '@/lib/types';

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
  updatedAt: string;
}

type FormState = Record<string, string>;

const TEXT_FIELDS: [string, string][] = [
  ['partCode', 'Part code *'],
  ['partDescription', 'Part description'],
  ['supplier', 'Supplier'],
  ['supplierPartNo', 'Supplier part no.'],
  ['usedFor', 'Used for'],
  ['location', 'Location'],
  ['orderWhen', 'Order when'],
  ['orderQty', 'Order qty'],
  ['deliveryTime', 'Delivery time'],
  ['tag', 'Tag'],
  ['barcode', 'Barcode'],
  ['customField1', 'Custom field 1'],
  ['customField2', 'Custom field 2'],
];

function initial(k?: Kanban): FormState {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    partCode: s(k?.partCode),
    partDescription: s(k?.partDescription),
    supplier: s(k?.supplier),
    supplierPartNo: s(k?.supplierPartNo),
    usedFor: s(k?.usedFor),
    location: s(k?.location),
    orderWhen: s(k?.orderWhen),
    orderQty: s(k?.orderQty),
    deliveryTime: s(k?.deliveryTime),
    tag: s(k?.tag),
    barcode: s(k?.barcode),
    customField1: s(k?.customField1),
    customField2: s(k?.customField2),
    price: s(k?.price),
    carriage: s(k?.carriage),
    color: s(k?.color) || '#1f5fbf',
    template: k?.template ?? '01',
    orderingType: k?.orderingType ?? 'url',
    orderingUrl: s(k?.orderingUrl),
    orderingEmail: s(k?.orderingEmail),
    orderingSopId: s(k?.orderingSopId),
  };
}

export function KanbanForm({ kanban, sops, onDone, onCancel }: { kanban?: Kanban; sops: SopListItem[]; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<FormState>(initial(kanban));
  const [picture, setPicture] = useState<MediaItem | null>(kanban?.picture ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function uploadPicture(file?: File) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const res = await apiRaw('/media', { method: 'POST', rawBody: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setError(body.message ?? 'Upload failed');
    else setPicture(body as MediaItem);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    const body: Record<string, unknown> = {
      ...Object.fromEntries(TEXT_FIELDS.map(([k]) => [k, f[k].trim() === '' ? null : f[k]])),
      partCode: f.partCode,
      price: num(f.price),
      carriage: num(f.carriage),
      color: f.color,
      template: f.template,
      orderingType: f.orderingType,
      orderingUrl: f.orderingType === 'url' ? f.orderingUrl : null,
      orderingEmail: f.orderingType === 'email' ? f.orderingEmail : null,
      orderingSopId: f.orderingType === 'sop' ? f.orderingSopId || null : null,
      pictureAssetId: picture?.id ?? null,
    };
    try {
      await api(kanban ? `/kanbans/${kanban.id}` : '/kanbans', { method: kanban ? 'PATCH' : 'POST', body });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card dialog" style={{ maxWidth: 760, maxHeight: '92vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
      <h3 style={{ marginTop: 0 }}>{kanban ? `Edit ${kanban.partCode}` : 'New kanban card'}</h3>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        {TEXT_FIELDS.map(([k, label]) => (
          <div className="field" key={k} style={{ marginBottom: 0 }}>
            <label htmlFor={k}>{label}</label>
            <input id={k} value={f[k]} onChange={set(k)} required={k === 'partCode'} />
          </div>
        ))}
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="template">Template</label>
          <select id="template" value={f.template} onChange={set('template')}>
            <option value="01">01 — standard</option>
            <option value="02">02 — with price & carriage</option>
          </select>
        </div>
        {f.template === '02' && (
          <>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="price">Price</label>
              <input id="price" type="number" min={0} step="0.01" value={f.price} onChange={set('price')} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="carriage">Carriage</label>
              <input id="carriage" type="number" min={0} step="0.01" value={f.carriage} onChange={set('carriage')} />
            </div>
          </>
        )}
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="color">Colour</label>
          <input id="color" type="color" value={f.color} onChange={set('color')} style={{ height: 36, padding: 2 }} />
        </div>
      </div>

      <h3>Ordering</h3>
      <div className="row">
        <select value={f.orderingType} onChange={set('orderingType')} style={{ width: 150 }}>
          <option value="url">Web link</option>
          <option value="email">Email</option>
          <option value="sop">SOP</option>
        </select>
        {f.orderingType === 'url' && <input placeholder="https://supplier.example.com/part" value={f.orderingUrl} onChange={set('orderingUrl')} style={{ flex: 1 }} required />}
        {f.orderingType === 'email' && <input type="email" placeholder="purchasing@example.com" value={f.orderingEmail} onChange={set('orderingEmail')} style={{ flex: 1 }} required />}
        {f.orderingType === 'sop' && (
          <select value={f.orderingSopId} onChange={set('orderingSopId')} style={{ flex: 1 }} required>
            <option value="">Choose SOP…</option>
            {sops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.referenceNo} — {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <h3>Picture</h3>
      <div className="row">
        {picture && (
          <div className="thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={picture.url} alt="" />
            <button type="button" onClick={() => setPicture(null)}>
              ✕
            </button>
          </div>
        )}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => void uploadPicture(e.target.files?.[0])} style={{ width: 'auto', border: 0 }} />
      </div>

      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginTop: 16 }}>
        <div className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
