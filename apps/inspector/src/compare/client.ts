const prefix = "/api/inspector/comparisons";

/** Calls the local comparison service; a failure carries the service's message. */
export async function comparisonRequest(operation: string, body: unknown): Promise<Response> {
  const response = await fetch(`${prefix}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

export async function comparisonJson<T>(operation: string, body: unknown): Promise<T> {
  return (await comparisonRequest(operation, body)).json();
}
