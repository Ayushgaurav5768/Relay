const STATUS_COLORS = {
  success: '#22c55e',
  failed: '#ef4444',
  pending: '#6b7280',
};

export default function Timeline({ attempts }) {
  if (!attempts || attempts.length === 0) {
    return <div className="empty-state">No delivery attempts recorded.</div>;
  }

  return (
    <div className="timeline">
      {attempts.map((a) => (
        <div key={a.id} className="timeline-item">
          <div className="timeline-marker" style={{ borderColor: STATUS_COLORS[a.status] || '#6b7280' }}>
            <div className="timeline-dot" style={{ backgroundColor: STATUS_COLORS[a.status] || '#6b7280' }} />
          </div>
          <div className="timeline-content">
            <div className="timeline-header">
              <span className={`badge badge-${a.status}`}>Attempt #{a.attempt_number}</span>
              <span className="timeline-status">{a.status}</span>
              <span className="timeline-date">{new Date(a.attempted_at).toLocaleString()}</span>
            </div>
            {a.http_status_code && (
              <div className="timeline-detail">
                HTTP {a.http_status_code}
              </div>
            )}
            {a.response_body_snippet && (
              <div className="timeline-detail">
                <pre className="response-snippet">{a.response_body_snippet}</pre>
              </div>
            )}
            {a.next_retry_at && (
              <div className="timeline-detail">
                Next retry: {new Date(a.next_retry_at).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
