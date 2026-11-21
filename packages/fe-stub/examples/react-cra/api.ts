// REACT_APP_API_URL is set to the stub API (http://localhost:3001) by `npm run start:stub`,
// and comes from your .env file otherwise.
const API_URL = process.env.REACT_APP_API_URL ?? 'https://api.example.com';

export async function createOrder(sku: string, qty: number) {
  const res = await fetch(`${API_URL}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku, qty }),
  });
  if (!res.ok) throw new Error((await res.json()).message);
  return res.json();
}
