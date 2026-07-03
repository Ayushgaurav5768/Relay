import { useState, useEffect, useCallback } from 'react';
import { fetchDestinations } from '../api';
import HealthIndicator from './HealthIndicator';
import LoadingSpinner from './LoadingSpinner';

export default function DestinationList({ refreshInterval = 5000 }) {
  const [destinations, setDestinations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchDestinations();
      setDestinations(data.destinations);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, refreshInterval);
    return () => clearInterval(id);
  }, [load, refreshInterval]);

  if (loading) return <LoadingSpinner text="Loading destinations..." />;
  if (error) return <div className="error-message">Failed to load destinations: {error}</div>;
  if (destinations.length === 0) return <div className="empty-state">No destinations configured.</div>;

  return (
    <div className="destination-list">
      <h2>Destinations</h2>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>URL</th>
              <th>Status</th>
              <th>Health</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {destinations.map((d) => (
              <tr key={d.id}>
                <td className="cell-mono">{d.id}</td>
                <td className="cell-url">{d.url}</td>
                <td><span className={`badge badge-${d.status}`}>{d.status}</span></td>
                <td><HealthIndicator health={d.health} /></td>
                <td className="cell-date">{new Date(d.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
