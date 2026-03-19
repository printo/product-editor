import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-slate-900">404</h1>
        <p className="text-slate-600 mt-2">Page not found</p>
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-700">Go Home</Link>
      </div>
    </div>
  );
}
