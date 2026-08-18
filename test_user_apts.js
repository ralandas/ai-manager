async function test() {
  const loginRes = await fetch("http://178.88.115.213/api/v2/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "rauan.az.2006@gmail.com", password: "rauan.az.2006@gmail.com" })
  });
  console.log("Login status:", loginRes.status);
  const data = await loginRes.json();
  console.log("User:", data.user);

  const aptRes = await fetch("http://178.88.115.213/api/v2/apartments", {
    headers: { "Authorization": "Bearer " + data.token }
  });
  console.log("Apartments status:", aptRes.status);
  const aptData = await aptRes.json();
  console.log("Apartments count:", aptData.apartments?.length);
  console.log("Source:", aptData.source);
  console.log("Sample apartment:", aptData.apartments?.[0]);
}
test();
