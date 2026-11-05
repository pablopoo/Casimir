/** @jsxImportSource react */
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Check, Minus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFateClient, useView, type ViewRef } from 'react-fate';
import { HealthView, healthRequest } from '../../fate/views.ts';
import { LastCheckedTime, StatusCard } from './StatusCard.tsx';

const serviceLabels: Record<string, string> = {
  api: 'API',
  proxy: 'Proxy',
  dashboard: 'Dashboard',
  dispatch: 'Dispatch',
  db: 'Database',
};

export function SystemStatusCard({ checkNames }: { checkNames: ReadonlyArray<string> }) {
  const client = useFateClient();
  const [healthRef, setHealthRef] = useState<ViewRef<'AdminHealth'> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const health = useView(HealthView, healthRef);
  useEffect(() => {
    let active = true;
    const retained = client.retain(healthRequest);
    const poll = async (mode: 'stale-while-revalidate' | 'network-only') => {
      try {
        const { health: ref } = await client.request(healthRequest, { mode });
        if (!ref) {
          throw new Error('Health data is unavailable.');
        }
        if (active) {
          setHealthRef(ref);
          setStatus('ready');
        }
      } catch {
        if (active) {
          setStatus('unavailable');
        }
      }
    };
    void poll('stale-while-revalidate');
    const interval = setInterval(() => void poll('network-only'), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
      retained.dispose();
    };
  }, [client]);
  const checksByName = new Map(health?.checks.map((check) => [check.name, check]));
  const overallState =
    status !== 'ready'
      ? status
      : !health || checkNames.some((name) => !checksByName.has(name))
        ? 'unavailable'
        : health.allOk
          ? 'healthy'
          : 'error';
  const overallLabel =
    overallState === 'healthy'
      ? 'All services healthy'
      : overallState === 'error'
        ? 'System checks failed'
        : overallState === 'loading'
          ? 'Checking system status'
          : 'System status unavailable';
  return (
    <StatusCard
      id="health-status"
      title="System Status"
      state={overallState}
      statusLabel={overallLabel}
      headerAccessory={
        <LastCheckedTime checkedAt={health?.checkedAt} unavailable={status === 'unavailable'} />
      }
    >
      <ul id="health-checks" className="void-admin-health-checks" aria-label="Service health">
        {checkNames.map((name) => {
          const label = serviceLabels[name] ?? name;
          const check = status === 'ready' ? checksByName.get(name) : undefined;
          const state =
            status === 'loading'
              ? 'loading'
              : !check
                ? 'unavailable'
                : check.ok
                  ? 'healthy'
                  : 'error';
          const detail =
            status !== 'ready'
              ? ''
              : !check
                ? 'Unavailable'
                : !check.ok
                  ? check.error || 'Health check failed.'
                  : '';
          const description =
            state === 'loading'
              ? 'Pending'
              : state === 'healthy'
                ? 'Healthy'
                : detail || 'Unavailable';
          const latency = check?.ok && check.latencyMs > 0 ? ` (${check.latencyMs}ms)` : '';
          return (
            <li
              key={name}
              className="void-admin-health-check"
              data-state={state}
              aria-label={`${label}: ${description}`}
              title={`${label}: ${description}${latency}`}
            >
              <span className="void-admin-health-indicator" aria-hidden="true">
                {state === 'healthy' ? (
                  <Check size={16} />
                ) : state === 'error' ? (
                  <X size={16} />
                ) : state === 'unavailable' ? (
                  <Minus size={16} />
                ) : null}
              </span>
              <Tooltip content={detail} isEnabled={!!detail} hasHoverIndication={false}>
                <span className="void-admin-health-service" tabIndex={detail ? 0 : undefined}>
                  <span className="void-admin-health-label">{label}</span>
                  {detail && <span className="void-admin-health-detail">{detail}</span>}
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </StatusCard>
  );
}
