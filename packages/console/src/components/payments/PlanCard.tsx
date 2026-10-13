import { Plan, PlanId, BillingInterval, isUpgrade, isDowngrade, getButtonLabel, perItem } from '@/utils/plans';
import { defaultOverageCapUsd } from '@/lib/plans-config';

interface PlanCardProps {
  plan: Plan;
  billingInterval: BillingInterval;
  currentUserPlan: PlanId;
  currentBillingInterval: BillingInterval;
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  renewalDate: string | null;
  highlightedPlan: string;
  pendingCancelPlan: string | null;
  processing: boolean;
  selectedPlan: string | null;
  onHighlight: (planId: string) => void;
  onResetPendingCancel: () => void;
  onCancelClick: (planId: string) => void;
  onSubscribe: (planId: string) => void;
}

export default function PlanCard({
  plan, billingInterval, currentUserPlan, currentBillingInterval,
  hasActiveSubscription, cancelAtPeriodEnd, renewalDate,
  highlightedPlan, pendingCancelPlan, processing, selectedPlan,
  onHighlight, onResetPendingCancel, onCancelClick, onSubscribe,
}: PlanCardProps) {
  const price = billingInterval === 'monthly' ? plan.monthlyPrice : plan.annualPrice;
  const isFree = !!plan.isFree;
  const isContactSales = !!plan.contactSales;
  const isCurrentPlan = isFree
    ? !hasActiveSubscription && currentUserPlan === 'demo'
    : hasActiveSubscription && plan.id === currentUserPlan;
  const isSameBillingInterval = billingInterval === currentBillingInterval;
  const isChangingBilling = isCurrentPlan && !isSameBillingInterval && !isFree;

  const wouldBeUpgrade = !isFree && !isContactSales && (
    isUpgrade(currentUserPlan, plan.id) ||
    (isCurrentPlan && currentBillingInterval === 'monthly' && billingInterval === 'annual')
  );

  const wouldBeDowngrade = !isFree && !isContactSales && hasActiveSubscription && (
    isDowngrade(currentUserPlan, plan.id) ||
    (isCurrentPlan && currentBillingInterval === 'annual' && billingInterval === 'monthly')
  );

  const defaultCapUsd = defaultOverageCapUsd(plan.id);
  const isHighlighted = plan.id === highlightedPlan;
  const isPendingCancel = pendingCancelPlan === plan.id;

  const badgeLabel = isFree && isCurrentPlan
    ? 'Current Plan'
    : !hasActiveSubscription
    ? 'Select Plan'
    : isChangingBilling
    ? `Change to ${billingInterval === 'annual' ? 'Annual' : 'Monthly'}`
    : isCurrentPlan
    ? 'Current Plan'
    : wouldBeDowngrade
    ? 'Downgrade'
    : 'Upgrade Now';

  const buttonLabel = getButtonLabel({
    planId: plan.id,
    planName: plan.name,
    planCta: plan.cta,
    isFree,
    isCurrentPlan,
    hasActiveSubscription,
    cancelAtPeriodEnd,
    isSameBillingInterval,
    isChangingBilling,
    pendingCancel: isPendingCancel,
    processing: processing && selectedPlan === plan.id,
    currentUserPlan,
    billingInterval,
  });

  return (
    <div
      className={`relative rounded-none shadow-md bg-white p-6 ${
        isHighlighted ? 'ring-2 ring-gray-500' : ''
      } cursor-pointer`}
      onClick={() => {
        onHighlight(plan.id);
        if (pendingCancelPlan && pendingCancelPlan !== plan.id) {
          onResetPendingCancel();
        }
      }}
    >
      {isHighlighted && !isContactSales && !(isFree && !isCurrentPlan) && (
        <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
          <span className="inline-flex items-center px-3 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
            {badgeLabel}
          </span>
        </div>
      )}

      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
        {isFree && (
          <span className="inline-flex items-center rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            on-ramp
          </span>
        )}
      </div>

      <div className="mb-4 flex items-baseline gap-1.5">
        {isContactSales ? (
          <span className="text-4xl font-bold text-gray-900">{plan.priceLabel || 'Custom'}</span>
        ) : (
          <>
            {/* Anchor price. Monthly only — it is a per-month figure, and showing
                it beside an annual total would compare two different units. */}
            {plan.listPrice !== undefined && billingInterval === 'monthly' && (
              <s className="text-xl font-medium text-gray-400 decoration-gray-400/70">
                ${plan.listPrice.toLocaleString()}
              </s>
            )}
            <span className="text-4xl font-bold text-gray-900">${price.toLocaleString()}</span>
            <span className="text-sm text-gray-500">
              /{billingInterval === 'monthly' ? 'mo' : 'yr'}
            </span>
          </>
        )}
      </div>

      {/* The two numbers that actually decide a tier, in the same shape the
          public pricing page uses. Tabular figures so they line up down the row. */}
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Included / mo</dt>
          <dd className="font-mono text-gray-900">{plan.monthlyUnits.toLocaleString('en-US')}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Additional</dt>
          <dd className="font-mono text-gray-900">
            {plan.additionalItem === null ? '—' : `${perItem(plan.additionalItem)} ea`}
          </dd>
        </div>
      </dl>

      <p className="mt-4 mb-6 border-t border-gray-200 pt-4 text-sm text-gray-600">{plan.note}</p>

      {isContactSales ? (
        <a
          href={plan.contactHref || '#'}
          onClick={(e) => e.stopPropagation()}
          className={`block w-full py-2 px-4 rounded-none text-sm font-medium text-center focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            isHighlighted
              ? 'bg-gray-600 text-white hover:bg-gray-700 focus:ring-gray-500'
              : 'bg-gray-50 text-gray-900 hover:bg-gray-100 focus:ring-gray-500'
          }`}
        >
          {plan.cta}
        </a>
      ) : (
        <button
          onClick={() => {
            if (isFree && isCurrentPlan) return;
            if (isCurrentPlan && isSameBillingInterval && !cancelAtPeriodEnd && !isFree) {
              onCancelClick(plan.id);
            } else {
              onSubscribe(plan.id);
            }
          }}
          disabled={processing || cancelAtPeriodEnd || (isFree && !hasActiveSubscription)}
          className={`w-full py-2 px-4 rounded-none text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            isPendingCancel
              ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
              : isFree && isCurrentPlan
              ? 'bg-gray-200 text-gray-600 cursor-default'
              : isHighlighted
              ? 'bg-gray-600 text-white hover:bg-gray-700 focus:ring-gray-500'
              : 'bg-gray-50 text-gray-900 hover:bg-gray-100 focus:ring-gray-500'
          } ${
            (processing || cancelAtPeriodEnd) ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {buttonLabel}
        </button>
      )}

      {isChangingBilling && !wouldBeUpgrade && !wouldBeDowngrade && (
        <p className="mt-2 text-xs text-gray-500 text-center">
          Billing change applies immediately current credits retained
        </p>
      )}

      {wouldBeDowngrade && (
        <p className="mt-2 text-xs text-gray-500 text-center">
          Downgrades apply immediately current credits retained
        </p>
      )}

      {/* A new subscription starts with a spend cap; say so before they commit. */}
      {!isFree && !isContactSales && !hasActiveSubscription && defaultCapUsd != null && (
        <p className="mt-2 text-xs text-gray-500 text-center">
          Additional items capped at ${defaultCapUsd.toLocaleString('en-US')}/mo to start. Change it on the Usage tab.
        </p>
      )}

      {isPendingCancel && (
        <p className="mt-2 text-xs text-red-600 text-center font-medium">
          Click again to confirm. Cancels at end of billing period.
        </p>
      )}

      {cancelAtPeriodEnd && isCurrentPlan && renewalDate && (
        <p className="mt-2 text-xs text-gray-500 text-center">
          Ends {new Date(renewalDate).toLocaleDateString()}.
        </p>
      )}
    </div>
  );
}
