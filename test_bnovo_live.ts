import { BnovoClient } from './src/pms/bnovo.js';

async function test() {
  const bnovo = new BnovoClient({
    username: 'progon@sutkispb.ru',
    password: 'progonprogon',
  });
  console.log("Fetching properties from Bnovo...");
  try {
    const props = await bnovo.listProperties();
    console.log("SUCCESS! Properties count:", props.length);
    console.log("Sample property:", props[0]);
  } catch (e) {
    console.error("Bnovo error:", e);
  }
}
test();
