import useSWR from 'swr';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { paymentsGet } from '../utils/payments-client';

interface UsageData {
  itemsUsed: number;
  includedItems: number;
  hardCap: boolean;
  extended?: {
    usage?: {
      total: number;
      // null = unlimited (paid tier with no customer overage cap)
      limit: number | null;
      remaining: number | null;
      percentage: number;
    };
  };
}

interface UsageStatus {
  isOverLimit: boolean;
  isNearLimit: boolean;
  // null when the plan is uncapped (paid, no overage cap)
  remainingItems: number | null;
  percentageUsed: number;
  // null when uncapped
  totalItems: number | null;
  usedItems: number;
  /** Free/hard-cap tier: blocking at the included limit is a hard stop. */
  hardCap: boolean;
  loading: boolean;
  error: any;
}

export function useUsageStatus(): UsageStatus {
  const { user } = useGraffiticodeAuth();
  // Key on the uid, not a URL: identity now travels in the Authorization
  // header, so the request path is the same for every account and would
  // collide in SWR's cache.
  const { data, error } = useSWR<UsageData>(
    user ? `payments-usage:${user.uid}` : null,
    () => paymentsGet(user, 'usage').then((r) => r.data),
    {
      refreshInterval: (data) => {
        if (!data) return 60000;
        const remaining = data.extended?.usage?.remaining;
        return remaining !== null && remaining !== undefined && remaining <= 0 ? 30000 : 60000;
      },
      revalidateOnFocus: true,
    }
  );

  const usedItems = data?.extended?.usage?.total ?? data?.itemsUsed ?? 0;
  const totalItems = data?.extended?.usage?.limit ?? (data ? data.includedItems : null);
  const remainingItems = data?.extended?.usage?.remaining ?? (
    totalItems === null ? null : Math.max(0, totalItems - usedItems)
  );
  const percentageUsed = data?.extended?.usage?.percentage
    ?? (totalItems && totalItems > 0 ? (usedItems / totalItems) * 100 : 0);

  // Uncapped (paid, no overage cap): never near/over the limit.
  const uncapped = totalItems === null;
  const isNearLimit = !uncapped && percentageUsed >= 80 && percentageUsed < 100;
  const isOverLimit = !uncapped && remainingItems !== null && remainingItems <= 0 && usedItems >= (totalItems ?? 0);

  return {
    isOverLimit,
    isNearLimit,
    remainingItems,
    percentageUsed: Math.min(percentageUsed, 999),
    totalItems,
    usedItems,
    hardCap: data?.hardCap ?? false,
    loading: !error && !data,
    error,
  };
}