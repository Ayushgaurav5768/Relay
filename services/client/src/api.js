const BASE = '/api';

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function fetchDestinations() {
  return request('/destinations');
}

export function fetchEvents({ page = 1, limit = 50, destination_id, status } = {}) {
  const params = new URLSearchParams();
  params.set('page', page);
  params.set('limit', limit);
  if (destination_id) params.set('destination_id', destination_id);
  if (status) params.set('status', status);
  return request(`/events?${params}`);
}

export function fetchEvent(id) {
  return request(`/events/${id}`);
}

export function replayEvent(id) {
  return request(`/events/${id}/replay`, { method: 'POST' });
}
