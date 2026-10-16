// Tiny pub/sub for pushing live updates to every open browser tab (server-sent events).
const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();
