import { notFound } from 'next/navigation';
import CalendarPreviewClient from './calendar-preview-client';

// Dev-only route — return the app's 404 in production builds so the
// unauthenticated calendar preview never ships to customers. Local dev
// (NODE_ENV=development) renders it normally. Mirrors the NODE_ENV gating
// convention used by ServiceWorkerRegistration.
export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <CalendarPreviewClient />;
}
