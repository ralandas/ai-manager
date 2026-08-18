async function test() {
  const loginRes = await fetch("http://178.88.115.213/api/v2/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "rauan.az.2006@gmail.com", password: "rauan.az.2006@gmail.com" })
  });
  const data = await loginRes.json();

  console.log("Calling GET /api/v2/calendar...");
  const calRes = await fetch("http://178.88.115.213/api/v2/calendar?from=2026-08-01&to=2026-08-31", {
    headers: { "Authorization": "Bearer " + data.token }
  });
  console.log("Calendar status:", calRes.status);
  const calData = await calRes.json();
  console.log("Properties in calendar:", calData.calendar?.properties?.length);
  console.log("Bookings in calendar:", calData.calendar?.bookings?.length);
  console.log("Closures in calendar:", calData.calendar?.closures?.length);
  if (calData.calendar?.properties?.[0]) {
    console.log("Property 1 photos:", calData.calendar.properties[0].photos.length);
  }
}
test();
