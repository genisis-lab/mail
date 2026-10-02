import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface AlertItem {
  id: number;
  kind: 'provider' | 'queue' | 'quota' | 'dns';
  key: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  link: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/** Open alerts, shared by the nav badge and the overview. */
export function useAlerts() {
  return useQuery({ queryKey: ['admin', 'alerts'], queryFn: () => api.get<{ open: AlertItem[]; recent: AlertItem[] }>('/api/admin/alerts'), refetchInterval: 60_000 });
}
