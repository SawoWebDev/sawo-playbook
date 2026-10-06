'use client';

import { useToast } from '@/components/feedback/Toast';
import { Loading } from '@/components/feedback/Loading';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate } from '@/lib/format';
import { hasPermission } from '@/lib/permissions';
import { NavMenuEditor } from '@/components/NavMenuEditor';
import type { NavConfig } from '@/components/nav-model';

interface OrgInfo {
  id: string;
  name: string;
  status: 'active' | 'pending_deletion' | 'suspended' | 'deleted';
  deletionScheduledFor: string | null;
  settings: { approvalRequired: boolean; approvalQuorum: number; allowSelfApproval: boolean; publicSopViewing: boolean; navConfig: NavConfig | null };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const toast = useToast();
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    api<OrgInfo>('/organization').then(setOrg).catch((e) => toast.error(errorMessage(e)));
  }, []);

  if (!org) return <Loading />;

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const { approvalRequired, approvalQuorum, allowSelfApproval, publicSopViewing } = org!.settings;
      setOrg(await api<OrgInfo>('/organization/settings', { method: 'PATCH', body: { approvalRequired, approvalQuorum, allowSelfApproval, publicSopViewing } }));
      toast.success('Settings saved.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const setSetting = <K extends keyof OrgInfo['settings']>(k: K, v: OrgInfo['settings'][K]) =>
    setOrg({ ...org, settings: { ...org.settings, [k]: v } });

  const st = org.settings;
  const statusLabel = org.status === 'pending_deletion' ? 'Deletion scheduled' : org.status.charAt(0).toUpperCase() + org.status.slice(1);

  return (
    <>
      <section className="pf-hero org-hero">
        <span className="org-hero-icon"><i className="fa-solid fa-building" aria-hidden /></span>
        <div className="pf-hero-text">
          <h2>{org.name}</h2>
          <span className="pf-hero-meta">Organization settings apply to everyone in this organization.</span>
        </div>
        <div className="pf-hero-badges">
          <span className={`pf-role${org.status === 'active' ? '' : ' is-off'}`}>
            <i className={`fa-solid ${org.status === 'active' ? 'fa-circle-check' : 'fa-triangle-exclamation'}`} aria-hidden /> {statusLabel}
          </span>
        </div>
      </section>

      <div className="kpi-grid">
        <div className={`kpi${st.approvalRequired ? ' kpi-good' : ''}`}>
          <span className="kpi-icon"><i className="fa-solid fa-stamp" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{st.approvalRequired ? 'On' : 'Off'}</span><span className="kpi-label">Approval before publishing</span></span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-users-viewfinder" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{st.approvalRequired ? st.approvalQuorum : '—'}</span><span className="kpi-label">Approvers needed</span></span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-user-check" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{st.allowSelfApproval ? 'Allowed' : 'Not allowed'}</span><span className="kpi-label">Self-approval</span></span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-qrcode" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{st.publicSopViewing ? 'Public' : 'Signed-in only'}</span><span className="kpi-label">QR viewing</span></span>
        </div>
      </div>

      <div className="org-grid">
        <div className="org-col">
          <form className="card org-card" onSubmit={save}>
            <div className="pf-card-head">
              <span className="kpi-icon"><i className="fa-solid fa-stamp" aria-hidden /></span>
              <div>
                <h3>Approval &amp; publishing</h3>
                <p className="muted">How new SOP versions reach operators.</p>
              </div>
            </div>

            <div className="org-setting">
              <div className="org-setting-text">
                <b>Require approval before publishing</b>
                <span className="muted">
                  Off: “Finish &amp; Save” in the editor publishes the SOP immediately. On: new versions must first be approved by Admins / Editors (other than the person who submitted it).
                </span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label="Require approval before publishing" checked={st.approvalRequired} onChange={(e) => setSetting('approvalRequired', e.target.checked)} />
            </div>

            {st.approvalRequired && (
              <>
                <div className="org-setting">
                  <div className="org-setting-text">
                    <label htmlFor="quorum"><b>Approval quorum</b></label>
                    <span className="muted">Distinct approvers needed before a version can be published.</span>
                  </div>
                  <input id="quorum" className="org-number" type="number" min={1} max={20} value={st.approvalQuorum} onChange={(e) => setSetting('approvalQuorum', Number(e.target.value))} />
                </div>
                <div className="org-setting">
                  <div className="org-setting-text">
                    <b>Allow self-approval</b>
                    <span className="muted">The person who submitted a version may also approve it.</span>
                  </div>
                  <input type="checkbox" role="switch" className="switch" aria-label="Allow self-approval" checked={st.allowSelfApproval} onChange={(e) => setSetting('allowSelfApproval', e.target.checked)} />
                </div>
              </>
            )}

            <div className="org-setting">
              <div className="org-setting-text">
                <b>Public QR viewing</b>
                <span className="muted">Anyone with a QR code can view published SOPs without signing in.</span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label="Allow viewing published SOPs via QR without signing in" checked={st.publicSopViewing} onChange={(e) => setSetting('publicSopViewing', e.target.checked)} />
            </div>

            <div className="pf-actions">
              <button className="btn btn-primary" type="submit">
                <i className="fa-solid fa-floppy-disk" aria-hidden /> Save settings
              </button>
            </div>
          </form>

          {hasPermission(user, 'organization.delete') && (
            <section className="card org-card org-danger">
              <div className="pf-card-head">
                <span className="kpi-icon"><i className="fa-solid fa-triangle-exclamation" aria-hidden /></span>
                <div>
                  <h3>Delete organization</h3>
                  <p className="muted">All data is deleted after a 14-day cooldown. Compliance records are kept until their retention window ends.</p>
                </div>
              </div>
              {org.status === 'pending_deletion' ? (
                <>
                  <p className="pf-small">
                    Deletion is scheduled for <strong>{fmtDate(org.deletionScheduledFor)}</strong>. You can cancel until then.
                  </p>
                  <div className="pf-actions">
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          setOrg(await api<OrgInfo>('/organization/deletion', { method: 'DELETE' }));
                          toast.success('Deletion cancelled.');
                        } catch (err) {
                          toast.error(errorMessage(err));
                        }
                      }}
                    >
                      Cancel deletion
                    </button>
                  </div>
                </>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      setOrg(await api<OrgInfo>('/organization/deletion', { method: 'POST', body: { confirmName, password } }));
                      setPassword('');
                      toast.success('Deletion requested. A 14-day cooldown has started.');
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  <div className="field">
                    <label htmlFor="cn">Type the organization name to confirm</label>
                    <input id="cn" value={confirmName} placeholder={org.name} onChange={(e) => setConfirmName(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="pw">Your password</label>
                    <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <div className="pf-actions">
                    <button className="btn btn-danger" type="submit" disabled={confirmName !== org.name || !password}>
                      <i className="fa-solid fa-trash" aria-hidden /> Request deletion
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
        </div>

        <div className="org-col">
          <NavMenuEditor saved={st.navConfig} onSaved={(navConfig) => setOrg({ ...org, settings: { ...org.settings, navConfig } })} />
        </div>
      </div>
    </>
  );
}
