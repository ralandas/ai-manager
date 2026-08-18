async function test() {
  const email = "user_test_login@progon.pro";
  const password = "password123";

  // Register
  const regRes = await fetch("http://178.88.115.213/api/v2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "LoginTest" })
  });
  console.log("Register status:", regRes.status);

  // Login
  const loginRes = await fetch("http://178.88.115.213/api/v2/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: email, password })
  });
  console.log("Login status:", loginRes.status);
  const data = await loginRes.json();
  console.log("Login data:", data);

  // Profile (/me)
  const meRes = await fetch("http://178.88.115.213/api/v2/me", {
    headers: { "Authorization": "Bearer " + data.token }
  });
  console.log("Profile status:", meRes.status);
  const meData = await meRes.json();
  console.log("Profile data:", meData);
}
test();
