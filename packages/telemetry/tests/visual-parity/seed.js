/**
 * Seeds a server with fixture data via HTTP API calls.
 */

export async function seedServer(baseUrl, fixtures) {
  for (const fixture of fixtures) {
    const url = `${baseUrl}${fixture.endpoint}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixture.body),
      });
      if (!resp.ok) {
        console.warn(`  [seed] ${fixture.endpoint} → ${resp.status}`);
      }
    } catch (err) {
      console.warn(`  [seed] ${fixture.endpoint} → ${err.message}`);
    }
    // Small delay between calls to let store process + emit events
    await sleep(50);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}