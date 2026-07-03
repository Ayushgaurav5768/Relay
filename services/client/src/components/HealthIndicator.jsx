const COLOR_MAP = {
  healthy: '#22c55e',
  degraded: '#eab308',
  unhealthy: '#ef4444',
  unknown: '#6b7280',
};

const LABEL_MAP = {
  healthy: 'Closed',
  degraded: 'Half-Open',
  unhealthy: 'Open',
  unknown: 'Unknown',
};

export default function HealthIndicator({ health }) {
  const color = COLOR_MAP[health] || COLOR_MAP.unknown;
  return (
    <span className="health-indicator">
      <span className="health-dot" style={{ backgroundColor: color }} />
      <span className="health-label">{LABEL_MAP[health] || health}</span>
    </span>
  );
}
