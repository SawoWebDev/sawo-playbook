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
  // Last saved values, so the page can tell when there are unsaved changes.
  const [baseline, setBaseline] = useState<OrgInfo['settings'] | null>(null);

  useEffect(() => {
    api<OrgInfo>('/organization')
      .then((o) => {
        setOrg(o);
        setBaseline(o.settings);
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  if (!org) return <Loading />;

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const { approvalRequired, approvalQuorum, allowSelfApproval, publicSopViewing } = org!.settings;
      const saved = await api<OrgInfo>('/organization/settings', { method: 'PATCH', body: { approvalRequired, approvalQuorum, allowSelfApproval, publicSopViewing } });
      setOrg(saved);
      setBaseline(saved.settings);
      toast.success('Settings saved.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const setSetting = <K extends keyof OrgInfo['settings']>(k: K, v: OrgInfo['settings'][K]) =>
    setOrg({ ...org, settings: { ...org.settings, [k]: v } });

  const st = org.settings;
  const statusLabel = org.status === 'pending_deletion' ? 'Deletion scheduled' : org.status.charAt(0).toUpperCase() + org.status.slice(1);
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const dirty = baseline !== null && (['approvalRequired', 'approvalQuorum', 'allowSelfApproval', 'publicSopViewing'] as const).some((k) => st[k] !== baseline[k]);
  const approvalSummary = st.approvalRequired
    ? `Right now, a new SOP version needs approval from ${people(st.approvalQuorum)} before it goes live. ${st.allowSelfApproval ? 'Its author may approve it too.' : 'Its author cannot approve it.'}`
    : 'Right now, editors publish SOP changes straight from the editor. No approval step.';

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

      <div className="kpi-grid org-kpis">
        <div className={`kpi${st.approvalRequired ? ' kpi-good' : ''}`}>
          <span className="kpi-icon"><i className="fa-solid fa-stamp" aria-hidden /></span>
          <span className="kpi-text">
            <span className="kpi-label">Approval before publishing</span>
            <span className="kpi-value">{st.approvalRequired ? 'On' : 'Off'}</span>
            <span className="kpi-hint">{st.approvalRequired ? 'New versions need sign-off' : 'Editors publish directly'}</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-users-viewfinder" aria-hidden /></span>
          <span className="kpi-text">
            <span className="kpi-label">Approvers needed</span>
            <span className="kpi-value">{st.approvalRequired ? people(st.approvalQuorum) : 'None'}</span>
            <span className="kpi-hint">{st.approvalRequired ? 'Different people, before going live' : 'Approval is off'}</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-user-check" aria-hidden /></span>
          <span className="kpi-text">
            <span className="kpi-label">Authors approving their own work</span>
            <span className="kpi-value">{st.approvalRequired ? (st.allowSelfApproval ? 'Allowed' : 'Not allowed') : '—'}</span>
            <span className="kpi-hint">{st.approvalRequired ? 'Self-approval setting' : 'Only applies when approval is on'}</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-qrcode" aria-hidden /></span>
          <span className="kpi-text">
            <span className="kpi-label">QR code access</span>
            <span className="kpi-value">{st.publicSopViewing ? 'Anyone' : 'Sign-in only'}</span>
            <span className="kpi-hint">{st.publicSopViewing ? 'Published SOPs open without signing in' : 'Viewers must sign in first'}</span>
          </span>
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
            <p className="org-summary">
              <i className="fa-solid fa-circle-info" aria-hidden /> {approvalSummary}
            </p>

            <div className="org-setting">
              <div className="org-setting-text">
                <b>Require approval before publishing</b>
                <span className="muted">
                  Off: editors publish straight from the SOP editor. On: each new version must be approved by an Admin or Editor who is not its author.
                </span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label="Require approval before publishing" checked={st.approvalRequired} onChange={(e) => setSetting('approvalRequired', e.target.checked)} />
            </div>

            {st.approvalRequired && (
              <>
                <div className="org-setting">
                  <div className="org-setting-text">
                    <label htmlFor="quorum"><b>Approvers needed</b></label>
                    <span className="muted">How many different people must approve a version before it goes live (1 to 20).</span>
                  </div>
                  <input id="quorum" className="org-number" type="number" min={1} max={20} value={st.approvalQuorum} onChange={(e) => setSetting('approvalQuorum', Number(e.target.value))} />
                </div>
                <div className="org-setting">
                  <div className="org-setting-text">
                    <b>Allow self-approval</b>
                    <span className="muted">Off: the person who wrote a version cannot approve it. On: they may approve their own version.</span>
                  </div>
                  <input type="checkbox" role="switch" className="switch" aria-label="Allow self-approval" checked={st.allowSelfApproval} onChange={(e) => setSetting('allowSelfApproval', e.target.checked)} />
                </div>
              </>
            )}

            <div className="org-setting">
              <div className="org-setting-text">
                <b>Public QR viewing</b>
                <span className="muted">On: anyone who scans a SOP's QR code can read it without signing in. Off: viewers must sign in first.</span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label="Allow viewing published SOPs via QR without signing in" checked={st.publicSopViewing} onChange={(e) => setSetting('publicSopViewing', e.target.checked)} />
            </div>

            <div className="pf-actions org-savebar">
              <span className={`org-dirty${dirty ? ' is-dirty' : ''}`} role="status">
                {dirty ? 'You have unsaved changes.' : 'All changes saved.'}
              </span>
              <button className="btn btn-primary" type="submit" disabled={!dirty}>
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
