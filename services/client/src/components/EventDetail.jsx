import { useState, useEffect } from 'react';
import { fetchEvent } from '../api';
import Timeline from './Timeline';
import ReplayButton from './ReplayButton';
import LoadingSpinner from './LoadingSpinner';

export default function EventDetail({ eventId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const result = await fetchEvent(eventId);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [eventId]);

  const handleReplayed = () => {
    setData((prev) => prev ? { ...prev, event: { ...prev.event, status: 'pending' } } : prev);
  };

  const handleReplayError = () => {
    load();
  };

  if (loading) return <LoadingSpinner text="Loading event..." />;
  if (error) return <div className="error-message">Failed to load event: {error}</div>;
  if (!data) return null;

  const { event, attempts } = data;

  return (
    <div className="event-detail">
      <button className="btn btn-back" onClick={onBack}>&larr; Back to Events</button>

      <div className="detail-card">
        <h2>Event Detail</h2>
        <dl className="detail-grid">
          <dt>ID</dt>
          <dd className="cell-mono">{event.id}</dd>
          <dt>Type</dt>
          <dd>{event.event_type}</dd>
          <dt>Destination</dt>
          <dd className="cell-mono">{event.destination_id}</dd>
          <dt>Status</dt>
          <dd><span className={`badge badge-${event.status}`}>{event.status}</span></dd>
          <dt>Created</dt>
          <dd>{new Date(event.created_at).toLocaleString()}</dd>
          <dt>Idempotency Key</dt>
          <dd className="cell-mono">{event.idempotency_key || '—'}</dd>
        </dl>
      </div>

      <div className="detail-card">
        <div className="detail-card-header">
          <h3>Delivery Attempts</h3>
          {event.status === 'dead' && (
            <ReplayButton eventId={event.id} onReplayed={handleReplayed} onError={handleReplayError} />
          )}
        </div>
        <Timeline attempts={attempts} />
      </div>
    </div>
  );
}
