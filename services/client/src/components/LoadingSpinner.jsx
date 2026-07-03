export default function LoadingSpinner({ text = 'Loading...' }) {
  return (
    <div className="loading-spinner">
      <div className="spinner" />
      <span>{text}</span>
    </div>
  );
}
