export default function FormIndexPage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-xl font-semibold">No form selected</h1>
      <p className="max-w-md text-gray-600">
        Open <code className="rounded bg-gray-100 px-1.5 py-0.5">/form/&lt;id&gt;</code> with a task
        or item id to render it.
      </p>
    </main>
  );
}
