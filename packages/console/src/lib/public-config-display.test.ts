// The console's pricing display and language catalog come from the
// installation's public configuration (installations plan, P3, slice 2b).
// Without a profile they must be exactly what the built-in code showed before
// the move: the plan cards, plan details, every button label and the enrollment
// caps match a snapshot recorded from the old module, and the catalog lists the
// same languages core's built-in selection did.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublicConfig } from '@graffiticode-app/core/profile/public-config-server';
import { loadInstallation, resetInstallation } from '@graffiticode-app/core/profile/runtime';
import { selectLanguages as coreSelectLanguages } from '@graffiticode-app/core/lib/languages';
import { planDisplay } from '../utils/plans';
import { catalogOf, catalogDomain } from './catalog';

const SNAPSHOT = new URL('./snapshots/plan-display.json', import.meta.url).pathname;
const EXAMPLE = new URL('../../../core/test/fixtures/installation-example', import.meta.url).pathname;
const ids = ['demo', 'starter', 'pro', 'teams', 'platinum'] as const;
afterEach(() => resetInstallation());

// Served, then parsed, as a browser receives it.
const served = () => JSON.parse(JSON.stringify(buildPublicConfig({} as any)));

function display(terms: any) {
  const m = planDisplay(terms);
  const labels: string[] = [];
  for (const from of ids) for (const to of ids) for (const isCurrentPlan of [false, true]) for (const hasActiveSubscription of [false, true]) {
    const p = m.plans.find(x => x.id === to);
    if (!p) continue;
    labels.push(m.getButtonLabel({ planId: to, planName: p.name, planCta: p.cta, isFree: !!p.isFree, isCurrentPlan, hasActiveSubscription, cancelAtPeriodEnd: false, isSameBillingInterval: true, isChangingBilling: false, pendingCancel: false, processing: false, currentUserPlan: from, billingInterval: 'monthly' }));
  }
  return { plans: m.plans, planDetails: m.planDetails, labels, caps: Object.fromEntries(ids.map(i => [i, m.defaultOverageCapUsd(i)])) };
}

test('without a profile, the pricing display is unchanged', () => {
  assert.deepEqual(display(served().billing.plans), JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
});

test('the pricing display follows the configured terms', () => {
  const terms = served().billing.plans;
  terms.pro = { ...terms.pro, displayName: 'Standard', basePriceMonthly: 30, includedItems: 300 };
  const m = planDisplay(terms);
  const pro = m.plans.find(p => p.id === 'pro')!;
  assert.equal(pro.name, 'Standard');
  assert.equal(pro.monthlyPrice, 30);
  assert.equal(pro.monthlyUnits, 300);
  assert.equal(pro.cta, 'Choose Standard');
  assert.match(m.plans.find(p => p.id === 'demo')!.note, /move to Standard/);
  assert.equal(m.planDetails.pro.name, 'Standard');
  assert.equal(m.defaultOverageCapUsd('pro'), 30);
});

test('without a profile, the catalog is the built-in selection', () => {
  const catalog = catalogOf(served().catalog.languages);
  const byId = (ls: { id: string }[]) => ls.map(l => l.id);
  assert.deepEqual(byId(catalog.selectLanguages()), byId([...coreSelectLanguages()].sort((a, b) => b.id.localeCompare(a.id))));
  for (const domain of ['assessments', 'sheets', 'diagrams']) {
    assert.deepEqual(byId(catalog.selectLanguages(domain)), byId([...coreSelectLanguages(domain)].sort((a, b) => b.id.localeCompare(a.id))), domain);
  }
  assert.equal(catalog.findLanguageByNumber('L180')?.id, '0180');
  assert.equal(catalog.findLanguageByNumber('0180')?.id, '0180');
});

// An example installation that offers two languages.
function restrictedProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
  p.catalog = { ...(p.catalog ?? {}), languages: ['0180', '0179'] };
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(p));
  return dir;
}

test("an installation lists only what it offers, and still resolves the rest for existing items", () => {
  loadInstallation({ PROFILE_DIR: restrictedProfile(), GOOGLE_CLOUD_PROJECT: 'example-installation' } as any);
  const catalog = catalogOf(served().catalog.languages);
  assert.deepEqual(catalog.selectLanguages().map(l => l.id), ['0180', '0179']);
  // An existing L0181 item (a deep link, an item's own language) still resolves.
  const l0181 = catalog.findLanguageByNumber('L0181');
  assert.equal(l0181?.id, '0181');
  assert.equal(l0181?.offered, false);
  assert.equal(catalog.findLanguageByNumber('9999'), undefined);
});

test('the domain filter is only one explicitly chosen, and never empties the picker', () => {
  loadInstallation({ PROFILE_DIR: restrictedProfile(), GOOGLE_CLOUD_PROJECT: 'example-installation' } as any);
  const catalog = catalogOf(served().catalog.languages);
  const domainOf = (id: string) => catalog.findLanguageByNumber(id)!.domains[0];
  // No choice: the whole offered catalog (never a domain made from the hostname).
  assert.equal(catalogDomain(undefined, catalog), undefined);
  // A domain naming none of the offered languages (what "console.acme.org"
  // used to become) filters nothing.
  assert.equal(catalogDomain('acme', catalog), undefined);
  assert.equal(catalogDomain('graffiticode', catalog), undefined);
  // An explicit domain an offered language has filters to it.
  const d = domainOf('0180');
  assert.ok(d, 'L0180 has a domain');
  assert.equal(catalogDomain(d.toUpperCase(), catalog), d);
  assert.ok(catalog.selectLanguages(catalogDomain(d, catalog)).some(l => l.id === '0180'));
  // A domain only a language it no longer offers has filters nothing.
  const only0181 = catalog.findLanguageByNumber('0181')!.domains.find(x => !catalog.selectLanguages(x).length);
  if (only0181) assert.equal(catalogDomain(only0181, catalog), undefined);
});
