import { useState, useEffect, useCallback } from 'react';
import { fetchEvents, fetchDestinations } from '../api';
import LoadingSpinner from './LoadingSpinner';

const STATUSES = ['', 'pending', 'delivered', 'failed', 'dead'];

export default function EventList({ onSelectEvent, refreshInterval }) {
  const [events, setEvents] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [filterDest, setFilterDest] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const limit = 20;

  const load = useCallback(async () => {
    try {
      const result = await fetchEvents({ page, limit, destination_id: filterDest || undefined, status: filterStatus || undefined });
      setEvents(result.events);
      setTotalPages(result.total_pages);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, filterDest, filterStatus]);

  useEffect(() => {
    fetchDestinations()
      .then((d) => setDestinations(d.destinations))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!refreshInterval) return;
    const id = setInterval(load, refreshInterval);
    return () => clearInterval(id);
  }, [load, refreshInterval]);

  const handleFilterChange = (setter) => (e) => {
    setter(e.target.value);
    setPage(1);
  };

  if (loading && events.length === 0) return <LoadingSpinner text="Loading events..." />;

  return (
    <div className="event-list">
      <h2>Events {total > 0 && <span className="count-badge">{total}</span>}</h2>

      <div className="filters">
        <select value={filterDest} onChange={handleFilterChange(setFilterDest)}>
          <option value="">All Destinations</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>{d.id}</option>
          ))}
        </select>
        <select value={filterStatus} onChange={handleFilterChange(setFilterStatus)}>
          <option value="">All Statuses</option>
          {STATUSES.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-state">No events found.</td>
              </tr>
            ) : (
              events.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => onSelectEvent(e.id)}>
                  <td className="cell-mono">{e.id.slice(0, 8)}...</td>
                  <td>{e.event_type}</td>
                  <td className="cell-mono">{e.destination_id}</td>
                  <td><span className={`badge badge-${e.status}`}>{e.status}</span></td>
                  <td>{e.attempt_count}</td>
                  <td className="cell-date">{new Date(e.created_at).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          &larr; Prev
        </button>
        <span className="page-info">Page {page} of {totalPages} ({total} total)</span>
        <button className="btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next &rarr;
        </button>
      </div>
    </div>
  );
}
