import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { paymentsGet, paymentsPost } from '../../utils/payments-client';
import { planDetails, type PlanId } from '../../utils/plans';
import { defaultOverageCapUsd } from '../../lib/plans-config';

interface UsageData {
  plan: string;
  itemsUsed: number;
  /** Free items in a sponsored language. Outside the allowance, never invoiced. */
  sponsoredItems?: number;
  /** Who is paying, e.g. ["Artcompiler Inc."]. */
  sponsors?: string[];
  /** Sponsored item counts per language, most first. */
  sponsoredByLanguage?: { lang: string; sponsor: string | null; items: number }[];
  includedItems: number;
  overageItems: number;
  overageRatePerItem: number | null;
  overageCostUsd: number;
  hardCap: boolean;
  /** A card is on file and overage meters (pay-as-you-go on a hard-capped tier). */
  payAsYouGoEnabled: boolean;
  /** The tier offers pay-as-you-go and this account hasn't enrolled yet. */
  payAsYouGoAvailable: boolean;
  overageLimitItems: number | null;
  overageLimitUsd: number | null;
  lastResetDate: string;
  currentPeriodEnd: string;
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Prefilled enrollment cap, from plans-config ($10 = 25 items on Bronze). The
// customer can change it before a card goes on file; the server applies the
// same default if none is sent.
const DEFAULT_ENROLL_CAP_USD = defaultOverageCapUsd('demo') ?? 0;

export default function UsageMonitor() {
  const { user } = useGraffiticodeAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCap, setSavingCap] = useState(false);
  const [capInput, setCapInput] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollCapInput, setEnrollCapInput] = useState(String(DEFAULT_ENROLL_CAP_USD));

  useEffect(() => {
    if (user) fetchUsageData();
  }, [user]);

  const fetchUsageData = async () => {
    try {
      const usageResponse = await paymentsGet(user, 'usage');
      setUsage(usageResponse.data);
      setCapInput(
        typeof usageResponse.data?.overageLimitUsd === 'number'
          ? String(usageResponse.data.overageLimitUsd)
          : ''
      );
    } catch (error) {
      console.error('Error fetching usage data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Enroll in pay-as-you-go: Checkout collects the card AND creates the $0-base
  // metered subscription in one step. The cap rides along so it is applied by
  // the subscription webhook — an abandoned Checkout leaves nothing behind.
  const enroll = async (limitUsd: number) => {
    if (enrolling) return;
    setEnrolling(true);
    try {
      const response = await paymentsPost(user, 'create-checkout-session', {
        planId: usage?.plan ?? 'demo',
        interval: 'monthly',
        overageLimitUsd: limitUsd,
      });
      window.location.href = response.data.checkoutUrl;
    } catch (error: any) {
      console.error('Error starting pay-as-you-go checkout:', error);
      alert(error?.response?.data?.message || error?.response?.data?.error ||
        'Could not start checkout. Please try again.');
      setEnrolling(false);
    }
  };

  const saveCap = async (limitUsd: number | null) => {
    if (savingCap) return;
    setSavingCap(true);
    try {
      await paymentsPost(user, 'overage-limit', { limitUsd });
      await fetchUsageData();
    } catch (error: any) {
      // Setting a cap on a tier that hasn't enrolled is the OTHER moment we ask
      // for payment details — the cap is meaningless until overage can be
      // billed, so carry the amount they chose straight into Checkout.
      if (error?.response?.status === 402 && error.response.data?.requiresPaymentMethod && limitUsd) {
        setSavingCap(false);
        await enroll(limitUsd);
        return;
      }
      console.error('Error setting overage limit:', error);
      alert('Failed to update overage limit. Please try again.');
    } finally {
      setSavingCap(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-32 bg-gray-200 rounded-none"></div>
        <div className="h-48 bg-gray-200 rounded-none"></div>
      </div>
    );
  }

  if (!usage) {
    return <div>Error loading usage data</div>;
  }

  // The plan track shows the included bucket only; overage has its own track
  // below, measured against the spend cap.
  const included = usage.includedItems;
  const used = usage.itemsUsed;
  const includedUsed = Math.min(used, included);
  const overageItems = usage.overageItems;
  const includedPct = included > 0 ? (includedUsed / included) * 100 : (used > 0 ? 100 : 0);

  // Sponsored items sit outside the plan and have no limit, so they're a count
  // grouped by sponsor rather than a track: a bar with nothing to fill toward
  // would read as a budget.
  const sponsoredItems = usage.sponsoredItems ?? 0;
  const sponsors = usage.sponsors ?? [];
  const sponsoredBySponsor = new Map<string, { lang: string; items: number }[]>();
  for (const row of usage.sponsoredByLanguage ?? []) {
    const key = row.sponsor ?? 'Sponsored';
    sponsoredBySponsor.set(key, [...(sponsoredBySponsor.get(key) ?? []), row]);
  }

  const isAtIncludedLimit = used >= included;
  const planName = planDetails[usage.plan as PlanId]?.name ?? usage.plan;

  // Customer overage cap remaining (paid tiers with a cap set).
  const capItems = usage.overageLimitItems;
  const capRemaining = capItems === null ? null : Math.max(0, included + capItems - used);
  const atCap = capItems !== null && used >= included + capItems;

  // Overage budget, shown whenever there is a cap to count down from — including
  // before any overage is used. Measured against the cap, with its own "N of M
  // remaining" label.
  const showOverageTrack = !usage.hardCap && capItems !== null && capItems > 0;
  const overageBudgetUsed = capItems === null ? 0 : Math.min(overageItems, capItems);
  const overageBudgetPct = capItems ? (overageBudgetUsed / capItems) * 100 : 0;
  const showTrackLabels = showOverageTrack;

  return (
    <div className="space-y-6">
      {/* Usage Overview */}
      <div className="bg-white overflow-hidden shadow rounded-none">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              Current Period Usage
            </h3>
            {(isAtIncludedLimit || atCap) && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                <ExclamationTriangleIcon className="w-4 h-4 mr-1" />
                {usage.hardCap ? 'Limit Reached' : atCap ? 'Spend Cap Reached' : 'Into Overage'}
              </span>
            )}
          </div>

          <div className="mt-2">
            <div className="flex justify-end text-sm text-gray-600 mb-1">
              <span>
                {/* A hard-capped account is counting down to a wall, so show what
                    is left. Once the cap is reached "0 of 25 remaining" says
                    nothing useful — fall back to the total, same as every other
                    plan. */}
                {usage.hardCap && used < included
                  ? `${(included - used).toLocaleString()} of ${included.toLocaleString()} remaining`
                  : `${used.toLocaleString()} items used`}
              </span>
            </div>
            {/* Labels only appear once there is a second track to tell apart. */}
            <div className={showTrackLabels ? 'flex items-center gap-3' : ''}>
              {showTrackLabels && (
                <span className="w-20 shrink-0 text-xs text-gray-500">Plan</span>
              )}
              <div className="w-full bg-gray-200 h-8 relative overflow-hidden">
                {/* Included usage */}
                <div
                  className={`h-8 absolute left-0 top-0 transition-all duration-300 ${
                    isAtIncludedLimit ? 'bg-gray-600' : 'bg-gray-500'
                  }`}
                  style={{ width: `${includedPct}%` }}
                  title={`Included: ${includedUsed.toLocaleString()} / ${included.toLocaleString()}`}
                />
              </div>
            </div>

            {showOverageTrack && capItems !== null && (
              <>
                <div className="mt-2 flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-gray-500">Overage</span>
                  <div className="w-full bg-gray-200 h-8 relative overflow-hidden">
                    <div
                      className={`h-8 absolute left-0 top-0 transition-all duration-300 ${atCap ? 'bg-red-600' : 'bg-yellow-500'}`}
                      style={{ width: `${overageBudgetPct}%` }}
                      title={`Overage: ${overageBudgetUsed.toLocaleString()} / ${capItems.toLocaleString()} items`}
                    />
                  </div>
                </div>
                <div className="mt-1 flex justify-end text-xs text-gray-500">
                  <span>
                    {(capItems - overageBudgetUsed).toLocaleString()} of {capItems.toLocaleString()} overage items remaining
                    {usage.overageLimitUsd != null && ` · ${money(usage.overageLimitUsd)} cap`}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Rendered only when there are some, so the common case is unchanged. */}
          {sponsoredItems > 0 && (
            <div className="mt-6 border-t pt-4">
              <h4 className="text-sm font-medium text-gray-700">Sponsored</h4>
              <p className="text-xs text-gray-500 mb-3">Free, and not counted toward your plan.</p>
              <dl className="space-y-3 text-sm">
                {Array.from(sponsoredBySponsor, ([sponsor, rows]) => (
                  <div key={sponsor}>
                    <dt className="text-gray-700">{sponsor}</dt>
                    {rows.map((row) => (
                      <dd key={row.lang} className="mt-1 flex justify-between gap-2 pl-4">
                        <span className="font-mono text-gray-600">{row.lang}</span>
                        <span className="font-mono text-gray-900">{row.items.toLocaleString()} items</span>
                      </dd>
                    ))}
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className="mt-6 border-t pt-4">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Usage Statistics</h4>
            <div className={`grid gap-4 ${sponsoredItems > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Included</dt>
                <dd className="mt-1">
                  <div className="text-2xl font-semibold text-gray-900">{included.toLocaleString()}</div>
                  <div className="text-xs text-gray-500">items / month</div>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Overage</dt>
                <dd className="mt-1">
                  <div className="text-2xl font-semibold text-gray-900">{overageItems.toLocaleString()}</div>
                  <div className="text-xs text-gray-500">
                    {usage.overageRatePerItem
                      ? `items · ${money(usage.overageCostUsd)} so far`
                      : 'items'}
                  </div>
                </dd>
              </div>
              {sponsoredItems > 0 && (
                <div>
                  <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Sponsored</dt>
                  <dd className="mt-1">
                    <div className="text-2xl font-semibold text-emerald-700">{sponsoredItems.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">
                      {sponsors.length > 0 ? `sponsored by ${sponsors.join(', ')}` : 'items · free'}
                    </div>
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Resets</dt>
                <dd className="mt-1">
                  <div className="text-2xl font-semibold text-gray-900">
                    {usage.currentPeriodEnd && new Date(usage.currentPeriodEnd).getFullYear() < 2099 ?
                      new Date(usage.currentPeriodEnd).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric'
                      }) : 'N/A'}
                  </div>
                  <div className="text-xs text-gray-500">
                    {usage.currentPeriodEnd && new Date(usage.currentPeriodEnd).getFullYear() < 2099 ? 'billing period resets' : 'no reset date'}
                  </div>
                </dd>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Overage spend cap */}
      <div className="bg-white overflow-hidden shadow rounded-none">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            {usage.payAsYouGoAvailable ? 'Keep Creating' : 'Overage Spend Cap'}
          </h3>

          {usage.payAsYouGoAvailable ? (
            <div className="bg-gray-50 border border-gray-200 rounded-none p-4">
              <p className="text-sm text-gray-600 mb-3">
                {planName} includes {included.toLocaleString()} items per month.
                {' '}Add a payment method to keep creating at{' '}
                <span className="font-medium">
                  {usage.overageRatePerItem ? money(usage.overageRatePerItem) : '—'} per item
                </span>
                , billed on your next invoice. Choose a monthly cap first — we stop new items
                once you reach it, so you can never be charged more than you picked.
              </p>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={enrollCapInput}
                    onChange={(e) => setEnrollCapInput(e.target.value)}
                    aria-label="Monthly spend cap in dollars"
                    className="pl-6 pr-3 py-2 w-40 border border-gray-300 rounded-none text-sm focus:outline-none focus:ring-1 focus:ring-gray-500"
                  />
                </div>
                <button
                  type="button"
                  disabled={enrolling || !(Number(enrollCapInput) > 0)}
                  onClick={() => enroll(Number(enrollCapInput))}
                  className="inline-flex justify-center rounded-none bg-gray-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800 disabled:opacity-50"
                >
                  {enrolling ? 'Redirecting…' : 'Add payment method'}
                </button>
              </div>
              {Number(enrollCapInput) > 0 && usage.overageRatePerItem ? (
                <p className="mt-2 text-xs text-gray-500">
                  {money(Number(enrollCapInput))} caps you at about{' '}
                  {Math.floor(Number(enrollCapInput) / usage.overageRatePerItem).toLocaleString()}{' '}
                  additional items per month. Change or remove it any time.
                </p>
              ) : null}
              <p className="mt-3 text-xs text-gray-500">
                Creating a lot more than that?{' '}
                <Link href="/billing" className="text-gray-600 hover:text-gray-800 font-medium">
                  Compare plans
                </Link>
                {' '}— paid tiers include a large bucket at a lower per-item rate.
              </p>
            </div>
          ) : usage.hardCap ? (
            <div className="bg-gray-50 border border-gray-200 rounded-none p-4">
              <p className="text-sm text-gray-600">
                {planName} is capped at {included.toLocaleString()} items per month with no
                overage.{' '}
                <Link href="/billing" className="text-gray-600 hover:text-gray-800 font-medium">
                  Upgrade to create more.
                </Link>
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm text-gray-500 mb-3">
                Additional items beyond your included {included.toLocaleString()} are billed at{' '}
                {usage.overageRatePerItem ? money(usage.overageRatePerItem) : '—'} each on your next
                invoice. Set a monthly cap to stop new items once you hit a dollar amount of overage.
                {capItems !== null && (
                  <> Current cap: <span className="font-medium">{money(usage.overageLimitUsd ?? 0)}</span>
                    {' '}(~{capItems.toLocaleString()} items
                    {capRemaining !== null && `, ${capRemaining.toLocaleString()} of budget remaining`}).</>
                )}
                {capItems === null && <> No cap set — overage is unlimited.</>}
              </p>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={capInput}
                    onChange={(e) => setCapInput(e.target.value)}
                    placeholder={usage.payAsYouGoEnabled ? 'Default' : 'No cap'}
                    className="pl-6 pr-3 py-2 w-40 border border-gray-300 rounded-none text-sm focus:outline-none focus:ring-1 focus:ring-gray-500"
                  />
                </div>
                <button
                  type="button"
                  disabled={savingCap}
                  onClick={() => saveCap(capInput === '' ? null : Number(capInput))}
                  className="inline-flex justify-center rounded-none bg-gray-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800 disabled:opacity-50"
                >
                  {savingCap ? 'Saving…' : 'Save cap'}
                </button>
                {capItems !== null && (
                  <button
                    type="button"
                    disabled={savingCap}
                    onClick={() => { setCapInput(''); saveCap(null); }}
                    className="inline-flex justify-center rounded-none bg-white px-3 py-2 text-sm font-semibold text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {usage.payAsYouGoEnabled ? 'Reset to default' : 'Remove cap'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
