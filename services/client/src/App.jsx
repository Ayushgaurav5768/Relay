import { useState } from 'react';
import DestinationList from './components/DestinationList';
import EventList from './components/EventList';
import EventDetail from './components/EventDetail';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

const POLL_INTERVAL = 5000;

export default function App() {
  const [view, setView] = useState('destinations');
  const [selectedEventId, setSelectedEventId] = useState(null);

  const navigateToEvents = () => setView('events');
  const navigateToDestinations = () => setView('destinations');

  const handleSelectEvent = (id) => {
    setSelectedEventId(id);
    setView('eventDetail');
  };

  const handleBackToEvents = () => {
    setSelectedEventId(null);
    setView('events');
  };

  return (
    <ErrorBoundary>
      <div className="app">
        <header className="app-header">
          <div className="header-left">
            <h1 className="app-title">Relay Dashboard</h1>
          </div>
          <nav className="app-nav">
            <button
              className={`nav-btn ${view === 'destinations' ? 'active' : ''}`}
              onClick={navigateToDestinations}
            >
              Destinations
            </button>
            <button
              className={`nav-btn ${view === 'events' || view === 'eventDetail' ? 'active' : ''}`}
              onClick={navigateToEvents}
            >
              Events
            </button>
          </nav>
        </header>
        <main className="app-main">
          {view === 'destinations' && <DestinationList refreshInterval={POLL_INTERVAL} />}
          {view === 'events' && <EventList onSelectEvent={handleSelectEvent} refreshInterval={POLL_INTERVAL} />}
          {view === 'eventDetail' && <EventDetail eventId={selectedEventId} onBack={handleBackToEvents} />}
        </main>
      </div>
    </ErrorBoundary>
  );
}
