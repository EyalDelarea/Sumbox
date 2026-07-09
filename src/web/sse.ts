/** Format one Server-Sent Event frame. `data` is JSON-encoded (single line). */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
