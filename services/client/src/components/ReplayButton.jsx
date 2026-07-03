import { useState } from 'react';
import { replayEvent } from '../api';

export default function ReplayButton({ eventId, onReplayed, onError }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);

  const handleClick = async () => {
    setLoading(true);
    setErr(null);
    if (onReplayed) onReplayed(eventId);
    try {
      await replayEvent(eventId);
      setDone(true);
    } catch (e) {
      setErr(e.message);
      setLoading(false);
      if (onError) onError(eventId, e.message);
    }
  };

  if (done) return <span className="replay-done">Re-queued</span>;

  return (
    <div>
      <button className="btn btn-replay" onClick={handleClick} disabled={loading}>
        {loading ? 'Re-queuing...' : 'Replay'}
      </button>
      {err && <div className="error-message replay-error">{err}</div>}
    </div>
  );
}
